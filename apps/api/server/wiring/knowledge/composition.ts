import {
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  DecideKnowledgeDispositionUseCase,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from "../../../../../packages/brief-knowledge/src/application/use-cases/index.js";

export interface KnowledgeComposition {
  captureCompletedAttemptNotes: CaptureCompletedAttemptNotesUseCase;
  checkKnowledgeClaim: CheckKnowledgeClaimUseCase;
  decideKnowledgeDisposition: DecideKnowledgeDispositionUseCase;
  proposeBriefContext: ProposeBriefContextUseCase;
  publishAcceptedKeeper: PublishAcceptedKeeperUseCase;
  recordContextSelection: RecordContextSelectionUseCase;
  recordKnowledgeReuse: RecordKnowledgeReuseUseCase;
  supersedeKnowledgeEntry: SupersedeKnowledgeEntryUseCase;
}

let composition: KnowledgeComposition | undefined;

export function getKnowledgeComposition(): KnowledgeComposition {
  composition ??= {
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase(),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase(),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase(),
    proposeBriefContext: new ProposeBriefContextUseCase(),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase(),
    recordContextSelection: new RecordContextSelectionUseCase(),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase(),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase(),
  };
  return composition;
}
