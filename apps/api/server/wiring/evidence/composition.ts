// Composition root wiring for the evidence-and-acceptance use cases.
// Routes receive instances from this module and never construct packages.
import {
  AssessHeadAcceptanceUseCase,
  InspectAcceptanceEvidenceUseCase,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
} from "../../../../../packages/evidence-and-acceptance/src/application/use-cases/index.js";

export interface EvidenceUseCases {
  requestVerification: RequestVerificationUseCase;
  recordVerificationReceipt: RecordVerificationReceiptUseCase;
  requestIndependentReview: RequestIndependentReviewUseCase;
  recordReviewReceipt: RecordReviewReceiptUseCase;
  assessHeadAcceptance: AssessHeadAcceptanceUseCase;
  inspectAcceptanceEvidence: InspectAcceptanceEvidenceUseCase;
  recordFindingDisposition: RecordFindingDispositionUseCase;
}

export function createEvidenceUseCases(): EvidenceUseCases {
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

let shared: EvidenceUseCases | null = null;

export function getEvidenceUseCases(): EvidenceUseCases {
  if (!shared) {
    shared = createEvidenceUseCases();
  }
  return shared;
}
