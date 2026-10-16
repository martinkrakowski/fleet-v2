// Composition root wiring for the evidence-and-acceptance use cases.
// Routes receive instances from this module and never construct packages.
import { join } from "node:path";

import {
  AttemptOwnerDecisionAdapter,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  ForgeEvidenceAdapter,
  IndependentReviewAdapter,
  OwnerDecisionAdapter,
  VerificationExecutorAdapter,
  type AttemptOwnerDecisionDelegate,
  type OwnerDecisionDelegate,
} from "@fleet/evidence-and-acceptance";
import { resolveRoleExecutors } from "@fleet/work-execution";
import { deriveInstallationModel, type FleetInstallation } from "@fleet/installation";
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
  // The forge mode comes from the loader-derived model (D6): mode `github`
  // binds the forge-evidence port, mode `none` keeps acceptance receipt-only
  // and records `forgeEvidence: 'not-configured'`.
  const installationModel = options?.installation
    ? deriveInstallationModel(options.installation).model
    : undefined;
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
  const reviewer = new IndependentReviewAdapter();
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
    }),
    recordReviewReceipt: new RecordReviewReceiptUseCase({ repo }),
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
