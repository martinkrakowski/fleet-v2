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
  const executor = new VerificationExecutorAdapter();
  const archive = new EvidenceArchiveAdapter(
    stateDir === undefined ? {} : { archiveDir: join(stateDir, "evidence-archive") },
  );
  const forgeEvidence = new ForgeEvidenceAdapter();
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
      forgeEvidence,
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
