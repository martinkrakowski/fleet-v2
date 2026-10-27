// Composition root wiring for the evidence-and-acceptance use cases.
// Routes receive instances from this module and never construct packages.
import { join } from "node:path";

import {
  AttemptOwnerDecisionAdapter,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  EvidenceSeatPolicyAdapter,
  ForgeEvidenceAdapter,
  IndependentReviewAdapter,
  OwnerDecisionAdapter,
  VerificationExecutorAdapter,
  type AttemptOwnerDecisionDelegate,
  type IndependentReviewTransportResult,
  type OwnerDecisionDelegate,
  type RunIndependentReviewRequest,
} from "@fleet/evidence-and-acceptance";
import { resolveRoleExecutors } from "@fleet/work-execution";
import { requireValidInstallationModel, type FleetInstallation } from "@fleet/installation";
import {
  AssessHeadAcceptanceUseCase,
  InspectAcceptanceEvidenceUseCase,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
} from "@fleet/evidence-and-acceptance/use-cases";

export interface EvidenceUseCases {
  requestVerification: RequestVerificationUseCase;
  recordVerificationReceipt: RecordVerificationReceiptUseCase;
  requestIndependentReview: RequestIndependentReviewUseCase;
  recordReviewReceipt: RecordReviewReceiptUseCase;
  assessHeadAcceptance: AssessHeadAcceptanceUseCase;
  inspectAcceptanceEvidence: InspectAcceptanceEvidenceUseCase;
  recordFindingDisposition: RecordFindingDispositionUseCase;
}

export interface EvidenceCrossContextDelegates {
  readonly ownerDecision?: OwnerDecisionDelegate;
  /** Reads the attempt record that carries the frozen owner decision doors. */
  readonly attemptOwnerDecision?: AttemptOwnerDecisionDelegate;
}

export interface EvidenceUseCasesOptions {
  readonly stateDir?: string;
  /** Parsed installation; the verifier role's host decides the executor. */
  readonly installation?: FleetInstallation;
  /**
   * Argument-array `gh` transport for forge evidence reads (D6). Mode
   * `github` hands it to the ForgeEvidenceAdapter so reads can succeed; the
   * runtime binds the reviewed subprocess runner, tests inject a stub.
   */
  readonly forgeGhRunner?: (
    args: readonly string[],
  ) => Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr?: string;
  }>;
  /**
   * Transport to the installation's reviewer seat, built by the runtime from the
   * reviewer chains. Absent means no reviewer is configured: requests report
   * `No independent review transport is configured`.
   */
  readonly runReview?: (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult>;
}

function createEvidenceUseCases(): EvidenceUseCases {
  return {
    requestVerification: new RequestVerificationUseCase(),
    recordVerificationReceipt: new RecordVerificationReceiptUseCase(),
    requestIndependentReview: new RequestIndependentReviewUseCase(),
    recordReviewReceipt: new RecordReviewReceiptUseCase(),
    assessHeadAcceptance: new AssessHeadAcceptanceUseCase(),
    inspectAcceptanceEvidence: new InspectAcceptanceEvidenceUseCase(),
    recordFindingDisposition: new RecordFindingDispositionUseCase(),
  };
}

export function createConfiguredEvidenceUseCases(
  options?: EvidenceUseCasesOptions,
  crossContext?: EvidenceCrossContextDelegates,
): EvidenceUseCases {
  const stateDir = options?.stateDir;

  const repo = new EvidenceAssessmentRepositoryAdapter({ stateDir });
  // The verification executor runs only allow-listed procedures, locally or
  // over the verifier role's ssh transport; with no installation (and so no
  // allow-list) executed checks report `unknown` until a receipt is recorded.
  const executor = new VerificationExecutorAdapter({
    executor: resolveRoleExecutors(options?.installation).verifier,
    allowListedCommands: options?.installation?.verification?.procedures,
  });
  const archive = new EvidenceArchiveAdapter(
    stateDir === undefined ? {} : { archiveDir: join(stateDir, "evidence-archive") },
  );
  // an invalid installation throws here, never runs
  const installationModel = options?.installation
    ? requireValidInstallationModel(options.installation)
    : undefined;
  // Free-seat flag (F5): a structural subset of the derived model; absent
  // installation or flag means allowed.
  const seatPolicy = new EvidenceSeatPolicyAdapter({
    useFreeSeats: installationModel?.policy?.useFreeSeats,
    seats: installationModel?.seats,
  });
  const forgeMode = installationModel?.forge?.mode;
  const forgeSection =
    installationModel?.forge !== undefined && "mode" in installationModel.forge
      ? installationModel.forge
      : undefined;
  const forgeGithubSection = forgeSection?.mode === "github" ? forgeSection : undefined;
  const forgeEvidenceAdapter =
    // Mode `none` never reads the forge; every other mode (github, or an
    // installation without a forge section, which keeps today's fail-closed
    // unknown reads) binds the port. Mode `github` binds the same
    // argument-array gh transport the forge action adapter uses, so reads
    // can succeed (D6).
    forgeMode === "none"
      ? undefined
      : new ForgeEvidenceAdapter({
          owner: forgeGithubSection?.owner,
          repo: forgeGithubSection?.repo,
          ...(options?.forgeGhRunner !== undefined
            ? { runGh: options.forgeGhRunner }
            : {}),
        });
  const reviewer = new IndependentReviewAdapter(
    options?.runReview !== undefined ? { runReview: options.runReview } : {},
  );
  const ownerDecisionPort = new OwnerDecisionAdapter(crossContext?.ownerDecision);
  const attemptOwnerDecisionPort = new AttemptOwnerDecisionAdapter(
    crossContext?.attemptOwnerDecision,
  );

  return {
    requestVerification: new RequestVerificationUseCase({ repo, executor, archive }),
    recordVerificationReceipt: new RecordVerificationReceiptUseCase({ repo }),
    requestIndependentReview: new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive,
      seatPolicy,
    }),
    recordReviewReceipt: new RecordReviewReceiptUseCase({ repo, seatPolicy }),
    assessHeadAcceptance: new AssessHeadAcceptanceUseCase({
      repo,
      // Mode `github` binds the forge-evidence port (with owner/repo); mode
      // `none` never reads the forge and records the not-configured value on
      // the assessment.
      ...(forgeEvidenceAdapter !== undefined ? { forgeEvidence: forgeEvidenceAdapter } : {}),
      ...(forgeMode === "none" ? { forgeMode: "none" as const } : {}),
      ownerDecisionPort,
      attemptOwnerDecisionPort,
    }),
    inspectAcceptanceEvidence: new InspectAcceptanceEvidenceUseCase({ repo }),
    recordFindingDisposition: new RecordFindingDispositionUseCase({ repo }),
  };
}

let shared: EvidenceUseCases | null = null;
let configured: EvidenceUseCases | null = null;

export function getEvidenceUseCases(): EvidenceUseCases {
  if (configured) {
    return configured;
  }
  shared ??= createEvidenceUseCases();
  return shared;
}

function isEvidenceUseCases(
  value: EvidenceUseCases | { stateDir?: string },
): value is EvidenceUseCases {
  return typeof value === "object" && "requestVerification" in value;
}

export function configureEvidenceUseCases(
  custom: EvidenceUseCases | { stateDir?: string } | null,
  crossContext?: EvidenceCrossContextDelegates,
): void {
  if (custom === null) {
    configured = null;
    shared = null;
    return;
  }
  configured = isEvidenceUseCases(custom)
    ? custom
    : createConfiguredEvidenceUseCases(custom, crossContext);
  shared = null;
}
