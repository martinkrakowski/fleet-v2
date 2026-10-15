import {
  ClaimVerificationAdapter,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
} from "@fleet/brief-knowledge";
import {
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  DecideKnowledgeDispositionUseCase,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from "@fleet/brief-knowledge/use-cases";

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

export interface KnowledgeCompositionOptions {
  readonly stateDir?: string;
}

let composition: KnowledgeComposition | undefined;
let configured: KnowledgeComposition | undefined;

function unconfiguredKnowledgeComposition(): KnowledgeComposition {
  return {
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase(),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase(),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase(),
    proposeBriefContext: new ProposeBriefContextUseCase(),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase(),
    recordContextSelection: new RecordContextSelectionUseCase(),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase(),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase(),
  };
}

export function getKnowledgeComposition(): KnowledgeComposition {
  if (configured) {
    return configured;
  }
  composition ??= unconfiguredKnowledgeComposition();
  return composition;
}

export function createConfiguredKnowledgeComposition(
  options?: KnowledgeCompositionOptions,
): KnowledgeComposition {
  const stateDir = options?.stateDir;

  const repo = new KnowledgeEntryRepositoryAdapter({ stateDir });
  const retrieval = new KnowledgeRetrievalAdapter();
  const verifier = new ClaimVerificationAdapter();
  const publisher = new KeeperPublicationAdapter({ stateDir });

  return {
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase({ repo }),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase({ repo, verifier }),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase({ repo }),
    proposeBriefContext: new ProposeBriefContextUseCase({ repo, retrieval }),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase({ repo, publisher }),
    recordContextSelection: new RecordContextSelectionUseCase({ repo }),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase({ repo }),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase({ repo }),
  };
}

function isKnowledgeComposition(
  value: KnowledgeComposition | { stateDir?: string },
): value is KnowledgeComposition {
  return typeof value === "object" && "captureCompletedAttemptNotes" in value;
}

export function configureKnowledgeComposition(
  custom: KnowledgeComposition | { stateDir?: string } | null,
): void {
  if (custom === null) {
    configured = undefined;
    composition = undefined;
    return;
  }
  configured = isKnowledgeComposition(custom)
    ? custom
    : createConfiguredKnowledgeComposition(custom);
  composition = undefined;
}
