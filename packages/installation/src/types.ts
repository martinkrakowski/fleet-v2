/**
 * Typed shapes of `installation/fleet.json`, schema versions 1 and 2.
 *
 * The file holds host references and paths to credential files; it never holds
 * credential values. In the merged result produced by `loadInstallation` the
 * v1 `runner` fields are all optional because environment overrides may
 * create a partial runner section; `parseInstallation` still requires `agent`
 * and `model` whenever a v1 file carries a `runner` section. The one exception
 * is `policy.telemetry.salt`, an installation secret that is never printed,
 * logged or sent (telemetry plan §3.2).
 */

/** One seat in the runner fallback chain. */
export interface FallbackSeat {
  readonly agent: string;
  readonly model: string;
  readonly variant?: string;
}

/** The `runner` section. */
export interface RunnerSection {
  readonly agent?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly remotePort?: number;
  readonly host?: string;
  readonly ocmRunBin?: string;
  readonly fallbackChain?: readonly FallbackSeat[];
}

/** The `worktree` section. */
export interface WorktreeSection {
  readonly sshHost: string;
}

/** A coverage reader the verification adapter implements (plan 2026-10-26 §3.1). */
export type CoverageReaderName = 'vitest-summary' | 'hexagen-lint-json' | 'eslint-json';
export type CoverageUnitKind = 'tests' | 'files' | 'checks';

/** What a procedure must cover; absent keeps the exit-0 rule. Changing it needs a new policy revision. */
export interface ProcedureCoverage {
  readonly reader: CoverageReaderName;
  readonly unitKind: CoverageUnitKind;
  readonly minUnits: number;
}

/** One named verification procedure. */
export interface VerificationProcedure {
  readonly command: string;
  readonly args?: readonly string[];
  readonly coverage?: ProcedureCoverage;
}

/** The `verification` section. */
export interface VerificationSection {
  readonly sshHost?: string;
  readonly procedures: Readonly<Record<string, VerificationProcedure>>;
}

/** The `forge` section. */
export interface ForgeSection {
  readonly owner: string;
  readonly repo: string;
}

/** The `reviewer` section. */
export interface ReviewerSection {
  readonly agent: string;
  readonly model: string;
  readonly variant?: string;
}

/** The `waves` section. */
export interface WavesSection {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly caFile?: string;
  readonly ownerPublicKey?: string;
}

/** The `shelf` section. */
export interface ShelfSection {
  readonly baseUrl: string;
  readonly keyFile: string;
}

/**
 * The v1 file shape, unchanged in meaning. `FleetInstallationV2` files map
 * onto the same v2 model through `deriveInstallationModel`.
 */
export interface FleetInstallationV1 {
  readonly schemaVersion: 1;
  readonly runner?: RunnerSection;
  readonly worktree?: WorktreeSection;
  readonly verification?: VerificationSection;
  readonly forge?: ForgeSection;
  readonly reviewer?: ReviewerSection;
  readonly waves?: WavesSection;
  readonly shelf?: ShelfSection;
}

// ---------------------------------------------------------------------------
// Schema v2 file shape
// ---------------------------------------------------------------------------

/** Roles one host may hold (plan section 1). */
export type HostRole = 'orchestrator' | 'lane-runner' | 'verifier';

/** How the installation reaches a host. */
export type HostTransport = 'local' | 'ssh';

/** Roles one seat may hold (plan section 3). */
export type SeatRole = 'implementer' | 'reviewer' | 'high-risk-reviewer';

/** Triggers that move a chain on to its next seat. */
export type ChainTrigger = '429' | '402' | 'timeout' | 'quota' | 'no-commit';

/** Cost class of a seat. */
export type CostClass = 'free' | 'plan-quota' | 'paid';

/** Operator-declared seat health (S1). Absent means healthy; an unhealthy seat is skipped by seat selection. */
export type SeatHealth = 'healthy' | 'unhealthy';

/** The chain keys: the three seat roles plus `fix`, the second-pass implementer chain (S1). */
export type ChainRole = SeatRole | 'fix';

/** Filesystem scope a v2 file may declare. `unknown` is derived only. */
export type DeclaredFilesystemScope = 'scoped-worktree' | 'inherited-directory';

/** How a runner capability declaration reached the derived model. Never a file field. */
export type RunnerCapabilitySource = 'declared' | 'undeclared' | 'legacy-asserted';

/**
 * A v2 runner capability declaration. There is no `source` field: a file
 * carrying one is refused, and the loader derives the source instead (D4).
 */
export interface RunnerCapabilityDeclaration {
  readonly networkEgressRestricted: boolean;
  readonly cpuAndMemoryLimited: boolean;
  readonly processTreeTermination: boolean;
  readonly filesystemScope: DeclaredFilesystemScope;
}

/**
 * The security-text acknowledgement a `full` agy runner must carry (D7).
 * `acceptedAt` is an ISO 8601 timestamp.
 */
export interface AgyAcknowledgement {
  readonly textVersion: string;
  readonly acceptedAt: string;
}

/**
 * The host-wide gate-slot throttle for conducted acceptance commands (KF-30b).
 * `path` is the absolute path of the trusted, host-installed `gate-slot`
 * wrapper the conducted gate prefixes every acceptance command with. `slots`
 * must equal the host-wide budget the hand-run gate uses; the code does not
 * enforce the equality, the operator declares it. A congestion `unknown`
 * verdict parks the run `ambiguous` at the gate (fail closed, visible to the
 * owner); automatic wait-and-retry is a separate unit (KF-30c).
 */
export interface GateSlotSection {
  readonly path: string;
  readonly slots: number;
}

/** The fields a host runner carries regardless of its kind. */
interface HostRunnerCommon {
  readonly port: number;
  readonly authFile?: string;
  readonly capabilities?: RunnerCapabilityDeclaration;
  readonly maxLanes?: number;
  readonly gateSlot?: GateSlotSection;
}

/** The `runner` block of a v2 host (D7): the kind selects the extra fields. */
export interface OpencodeHostRunnerSection extends HostRunnerCommon {
  readonly kind: 'opencode';
}

/** An agy runner declares its mode (D7); `full` also needs the acknowledgement. */
export interface AgyHostRunnerSection extends HostRunnerCommon {
  readonly kind: 'agy';
  readonly agyMode: 'edit-only' | 'full';
  readonly agyAcknowledgement?: AgyAcknowledgement;
}

export type HostRunnerSection = OpencodeHostRunnerSection | AgyHostRunnerSection;

/** One named v2 host (plan section 1). */
export interface HostSection {
  readonly transport: HostTransport;
  readonly sshAlias?: string;
  readonly worktreeRoot: string;
  readonly tmpDir?: string;
  readonly roles: readonly HostRole[];
  readonly runner?: HostRunnerSection;
}

/** One v2 seat (plan section 3). */
export interface SeatSection {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly roles: readonly SeatRole[];
  readonly costClass: CostClass;
  readonly health?: SeatHealth;
}

/** One ordered step of a role's chain. */
export interface ChainStep {
  readonly seatId: string;
  readonly triggers?: readonly ChainTrigger[];
}

/** The v2 `chains` section: one ordered seat list per role. */
export interface ChainsSection {
  readonly implementer?: readonly ChainStep[];
  readonly reviewer?: readonly ChainStep[];
  readonly 'high-risk-reviewer'?: readonly ChainStep[];
  /**
   * The second-pass / fix implementer chain (S1). Its seats hold the
   * `implementer` role. Absent: fix rounds use the implementer chain.
   */
  readonly fix?: readonly ChainStep[];
}

/** One forbidden route rule of the policy shape. */
export interface ForbiddenRouteRule {
  readonly tool: string;
  readonly modelPattern: string;
}

/** How much of a lane's live session the tail may show (plan §3.7, D10). */
export type LiveTailContent = 'summaries' | 'full';

/**
 * The v2 `policy.liveTail` section. `summaries`: step index, tool name, path,
 * byte counts, elapsed time, exit codes, model and seat, runner status lines.
 * `full`: an installation opt-in to stream lane output through, never persisted.
 */
export interface LiveTailPolicy {
  readonly content: LiveTailContent;
}

/** What auto-merge does when acceptance is blocked by anything but a first-look ci-pending (plan A1, §4). */
export type AutoMergeOnBlocked = 'ask-owner' | 'hold';

/**
 * The v2 `policy.autoMerge` section (auto-merge plan A1). Off unless `enabled`; a
 * high-risk lane is excluded unless `allowHighRisk`. A present block names all three
 * fields. It grants nothing by itself: grants are issued per merge (AM3a, AM4a).
 */
export interface AutoMergePolicy {
  readonly enabled: boolean;
  readonly allowHighRisk: boolean;
  readonly onBlocked: AutoMergeOnBlocked;
}

/**
 * Reaper finding kinds that have a repair (conductor plan §3.9.2, D14). The first four are
 * record-only; `orphan-session` aborts a session and is destructive. `driverless-run` and
 * `orphan-worktree` are report-only and have no repair (D15: no worktree removal).
 */
export type ConductorReaperRepairKind =
  | 'dead-attempt'
  | 'leaked-slot'
  | 'stale-stop'
  | 'stale-attention'
  | 'orphan-session';

/** Per-kind repair opt-ins as written in the file; an absent kind is off. */
export type ConductorReaperRepairs = Readonly<Partial<Record<ConductorReaperRepairKind, boolean>>>;

/** The v2 `policy.conductor.reaper` section as written; only `enabled` is required. */
export interface ConductorReaperPolicy {
  readonly enabled: boolean;
  readonly intervalMinutes?: number;
  readonly graceMinutes?: number;
  readonly staleStopMinutes?: number;
  readonly repairs?: ConductorReaperRepairs;
}

/**
 * The v2 `policy.conductor` section as written (conductor plan §3.7, §3.9). Off unless
 * `enabled`; only `enabled` is required. It grants nothing by itself: forge actions still
 * need a policy grant (AM3a), merges also `policy.autoMerge`.
 */
export interface ConductorPolicy {
  readonly enabled: boolean;
  readonly stopGraceMinutes?: number;
  readonly reaper?: ConductorReaperPolicy;
}

/** Where an exported span went (telemetry plan §3.9): recorded in each `exported@<route>` disposition. */
export type TelemetryRoute = 'collector' | 'phoenix';

/**
 * The v2 `policy.telemetry` section as written (telemetry plan §3.9). Off unless `enabled`; only `enabled`
 * is required, and `salt` is required when `enabled` is true. `salt` is never printed, logged or sent.
 */
export interface TelemetryPolicy {
  readonly enabled: boolean;
  readonly projectName?: string;
  readonly route?: TelemetryRoute;
  readonly sampleRatio?: number;
  readonly sendCost?: boolean;
  readonly includeDryRun?: boolean;
  /** Project id → alias sent as `fleet.project`; a project without one is sent as its salted digest. */
  readonly projectAliases?: Readonly<Record<string, string>>;
  /** 64–256 lowercase hex characters: the one installation salt for digests and ids (D4, D14). */
  readonly salt?: string;
}

/** The effective telemetry policy: every field present (`resolveTelemetryPolicy`). */
export interface ResolvedTelemetryPolicy {
  readonly enabled: boolean;
  readonly projectName: string;
  readonly route: TelemetryRoute;
  readonly sampleRatio: number;
  readonly sendCost: boolean;
  readonly includeDryRun: boolean;
  readonly projectAliases: Readonly<Record<string, string>>;
  /** Null when the file has none; telemetry then refuses to start. */
  readonly salt: string | null;
}

/** The effective reaper policy: every field present. */
export interface ResolvedConductorReaperPolicy {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly graceMinutes: number;
  readonly staleStopMinutes: number;
  readonly repairs: Readonly<Record<ConductorReaperRepairKind, boolean>>;
}

/** The effective conductor policy: every field present (`resolveConductorPolicy`). */
export interface ResolvedConductorPolicy {
  readonly enabled: boolean;
  readonly stopGraceMinutes: number;
  readonly reaper: ResolvedConductorReaperPolicy;
}

/** A seat role whose starting seat may rotate across a project's lanes (MCP tooling plan §3.5.2, D4). */
export type SeatRotationRole = 'first-pass' | 'fix' | 'review' | 'pre-merge';

/**
 * The v2 `policy.seats` section as written (MCP tooling plan §3.5.2). Every field is optional. `rotate` lists
 * the roles whose starting seat rotates across lanes (absent or empty: fixed order); `cooldownMinutes` is how
 * long a model refused in one lane is skipped by every lane (D5; 0 turns it off); `observationCooldownMinutes`
 * is the same for seat observations, off unless above 0 (D7). Nothing here is written into a seat's `health`.
 */
export interface SeatsPolicy {
  readonly rotate?: readonly SeatRotationRole[];
  readonly cooldownMinutes?: number;
  readonly observationCooldownMinutes?: number;
}

/** The effective seat policy: every field present (`resolveSeatsPolicy`). */
export interface ResolvedSeatsPolicy {
  readonly rotate: readonly SeatRotationRole[];
  readonly cooldownMinutes: number;
  readonly observationCooldownMinutes: number;
}

/**
 * The v2 `policy` section: shape only. The rules are enforced by the loader
 * itself through `validateSeatPolicy` (lane O5) on every v2 file.
 */
export interface PolicySection {
  readonly forbiddenRoutes?: readonly ForbiddenRouteRule[];
  readonly perLaneCostCeiling?: number;
  /** Absent means true: free-tier seats are used. */
  readonly useFreeSeats?: boolean;
  /** Absent means `{ content: 'summaries' }`; read it through `resolveLiveTailContent`. */
  readonly liveTail?: LiveTailPolicy;
  /** Absent means off (`DEFAULT_AUTO_MERGE_POLICY`); read it through `resolveAutoMergePolicy`. */
  readonly autoMerge?: AutoMergePolicy;
  /** Absent means off (`DEFAULT_CONDUCTOR_POLICY`); read it through `resolveConductorPolicy`. */
  readonly conductor?: ConductorPolicy;
  /** Absent means off (`DEFAULT_TELEMETRY_POLICY`); read it through `resolveTelemetryPolicy`. */
  readonly telemetry?: TelemetryPolicy;
  /** Absent means no rotation, 60-minute cooling, observations off (`DEFAULT_SEATS_POLICY`); read it through `resolveSeatsPolicy`. */
  readonly seats?: SeatsPolicy;
}

/** The v2 `shelf` section with the local provider (D1, default). */
export interface LocalShelfSection {
  readonly provider: 'local';
}

/** The v2 `shelf` section with the git provider (D1). */
export interface GitShelfSection {
  readonly provider: 'git';
  readonly repoDir: string;
  readonly branch: string;
  readonly pathPrefix: string;
}

/** The v2 `shelf` section (D1). */
export type ShelfSectionV2 = LocalShelfSection | GitShelfSection;

/** The v2 `forge` section with mode `github` (D6). */
export interface GithubForgeSection {
  readonly mode: 'github';
  readonly owner: string;
  readonly repo: string;
}

/** The v2 `forge` section with mode `none` (D6). */
export interface NoForgeSection {
  readonly mode: 'none';
}

/** The v2 `forge` section (D6). */
export type ForgeSectionV2 = GithubForgeSection | NoForgeSection;

/** The v2 `verification` section: procedures only; ssh hosts live in `hosts`. */
export interface VerificationProceduresSection {
  readonly procedures: Readonly<Record<string, VerificationProcedure>>;
}

/** The v2 `decisions` block with the `none` provider (D3). */
export interface NoDecisionsSection {
  readonly provider: 'none';
}

/**
 * Per-consumer decision settings (K3, plan section 2). Every field is
 * optional: an absent `minConfidence` falls back to the block's, and an
 * absent `monthlyBudgetUsd` means the consumer has no sub-budget clause
 * (only the block total applies).
 */
export interface ConsumerSettings {
  readonly minConfidence?: number;
  readonly monthlyBudgetUsd?: number;
}

/**
 * Settings of the `claim-triage` consumer (K3, plan section 2): a
 * `ConsumerSettings` plus the acknowledgement that unreviewed candidate
 * claims may leave the host. It is required whenever the `claim-triage`
 * entry is present.
 */
export interface ClaimTriageSettings extends ConsumerSettings {
  readonly acknowledgeCandidateClaimsLeaveHost: true;
}

/** The per-consumer settings map of a `decisions` block (K3). */
export interface DecisionConsumers {
  readonly 'knowledge-ranking'?: ConsumerSettings;
  readonly 'claim-triage'?: ClaimTriageSettings;
}

/** The v2 `decisions` block with the Jev provider (D3). */
export interface JevDecisionsSection {
  readonly provider: 'jev';
  readonly model: string;
  readonly keyFile: string;
  readonly minConfidence: number;
  readonly monthlyBudgetUsd: number;
  readonly assumedCostPerCallUsd: number;
  readonly acknowledgeProseLeavesHost: true;
  readonly disabledProjects?: readonly string[];
  readonly consumers?: DecisionConsumers;
}

/** The v2 `decisions` block with the answer-file provider (D3). */
export interface AnswerFileDecisionsSection {
  readonly provider: 'answer-file';
  readonly answerFile: string;
  readonly consumers?: DecisionConsumers;
}

/** The v2 `decisions` block (D3). */
export type DecisionsSectionV2 =
  | NoDecisionsSection
  | JevDecisionsSection
  | AnswerFileDecisionsSection;

/** The v2 file shape (plan section 1). */
export interface FleetInstallationV2 {
  readonly schemaVersion: 2;
  readonly hosts: Readonly<Record<string, HostSection>>;
  /**
   * Required (D6): a v2 file always declares a forge mode, `{ mode: 'github',
   * owner, repo }` or `{ mode: 'none' }`. Only the v1 file and the env-only
   * setup may run without a forge section.
   */
  readonly tools?: readonly string[];
  readonly seats?: readonly SeatSection[];
  readonly chains?: ChainsSection;
  readonly policy?: PolicySection;
  readonly shelf?: ShelfSectionV2;
  readonly forge: ForgeSectionV2;
  readonly verification?: VerificationProceduresSection;
  readonly waves?: WavesSection;
  readonly decisions?: DecisionsSectionV2;
}

// ---------------------------------------------------------------------------
// Derived v2 model
// ---------------------------------------------------------------------------

/**
 * Runner capabilities as the loader derives them. `null` booleans mean the
 * declaration does not say; `filesystemScope: "unknown"` means the runner is
 * undeclared and dispatch must refuse it (D4).
 */
export interface DerivedRunnerCapabilities {
  readonly source: RunnerCapabilitySource;
  readonly filesystemScope: DeclaredFilesystemScope | 'unknown';
  readonly networkEgressRestricted: boolean | null;
  readonly cpuAndMemoryLimited: boolean | null;
  readonly processTreeTermination: boolean | null;
}

/** An opencode runner of the model; capabilities are always derived. */
export interface OpencodeHostRunnerModel {
  readonly kind: 'opencode';
  readonly port?: number;
  readonly authFile?: string;
  readonly capabilities: DerivedRunnerCapabilities;
  readonly maxLanes?: number;
  readonly gateSlot?: GateSlotSection;
}

/** An agy runner of the model; the mode decides the agy argv (D7). */
export interface AgyHostRunnerModel {
  readonly kind: 'agy';
  readonly port?: number;
  readonly authFile?: string;
  readonly capabilities: DerivedRunnerCapabilities;
  readonly maxLanes?: number;
  readonly gateSlot?: GateSlotSection;
  readonly agyMode: 'edit-only' | 'full';
  readonly agyAcknowledgement?: AgyAcknowledgement;
}

/** The `runner` block of a model host; capabilities are always derived. */
export type HostRunnerModel = OpencodeHostRunnerModel | AgyHostRunnerModel;

/**
 * One host of the derived model. `worktreeRoot` is absent for hosts mapped
 * from v1, which carries no such path.
 */
export interface HostModel {
  readonly transport: HostTransport;
  readonly sshAlias?: string;
  readonly worktreeRoot?: string;
  readonly tmpDir?: string;
  readonly roles: readonly HostRole[];
  readonly runner?: HostRunnerModel;
}

/** A host model with writable properties, used while the mapping builds one. */
export type MutableHostModel = { -readonly [K in keyof HostModel]: HostModel[K] };

/**
 * One seat of the derived model. `costClass` is absent for seats mapped from
 * v1, which carries no cost information.
 */
export interface SeatModel {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly roles: readonly SeatRole[];
  readonly costClass?: CostClass;
  readonly health?: SeatHealth;
}

/**
 * The v2 model the loader derives from a file of either version: every v1
 * section maps onto it, and every runner capability `source` is derived (D4).
 */
export interface FleetInstallationModel {
  readonly schemaVersion: 2;
  readonly hosts: Readonly<Record<string, HostModel>>;
  readonly tools?: readonly string[];
  readonly seats?: readonly SeatModel[];
  readonly chains?: ChainsSection;
  readonly policy?: PolicySection;
  readonly shelf?: ShelfSectionV2;
  readonly forge?: ForgeSectionV2;
  readonly verification?: VerificationProceduresSection;
  readonly waves?: WavesSection;
  readonly decisions?: DecisionsSectionV2;
}

// ---------------------------------------------------------------------------
// Union of both file versions
// ---------------------------------------------------------------------------

/**
 * A parsed installation file, `schemaVersion` 1 or 2.
 *
 * The v1 sections appear only in a v1 file and the v2 sections only in a v2
 * file; `parseInstallation` enforces the split and never returns a mix. The
 * type stays one flat interface, not a discriminated union, because existing
 * consumers read the v1 sections regardless of version; `verification`,
 * `forge` and `shelf` differ per version and are unions here. The precise
 * per-version shapes are `FleetInstallationV1` and `FleetInstallationV2`.
 */
export interface FleetInstallation {
  readonly schemaVersion: 1 | 2;
  /** v1: the lane runner seat and its fallback chain. Never set in v2. */
  readonly runner?: RunnerSection;
  /** v1: the host holding the git worktrees. Never set in v2. */
  readonly worktree?: WorktreeSection;
  /** v1: procedures and verification host. v2: procedures only. */
  readonly verification?: VerificationSection | VerificationProceduresSection;
  /** v1: GitHub owner and repository. v2: a forge mode (D6), required in v2. */
  readonly forge?: ForgeSection | ForgeSectionV2;
  /** v1: the reviewer seat. Never set in v2. */
  readonly reviewer?: ReviewerSection;
  readonly waves?: WavesSection;
  /** v1: removed snippet transport (D1), accepted and ignored. v2: local or git. */
  readonly shelf?: ShelfSection | ShelfSectionV2;
  /** v2: named hosts with transports, roles and runners. Never set in v1. */
  readonly hosts?: Readonly<Record<string, HostSection>>;
  /** v2: enabled tool ids. Never set in v1. */
  readonly tools?: readonly string[];
  /** v2: seats. Never set in v1. */
  readonly seats?: readonly SeatSection[];
  /** v2: per-role seat chains. Never set in v1. */
  readonly chains?: ChainsSection;
  /** v2: policy shape; rules arrive through the loader's `validatePolicy` hook. Never set in v1. */
  readonly policy?: PolicySection;
  /** v2: decision provider configuration (D3). Never set in v1. */
  readonly decisions?: DecisionsSectionV2;
}
