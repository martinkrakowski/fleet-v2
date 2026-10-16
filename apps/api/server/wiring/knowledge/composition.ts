import {
  AdvisedKnowledgeRetrievalAdapter,
  ClaimVerificationAdapter,
  createRankingAdvice,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
  type RankingAdviceDecisions,
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
  /**
   * Repository override (tests only): without a stateDir the composition's
   * store is a private in-memory repository, so a test cannot seed the keepers
   * ProposeBriefContextUseCase reads. Injecting the repository is the API
   * composition's equivalent of the CLI runtime's exposed
   * `knowledge.knowledgeEntryRepository`.
   */
  readonly knowledgeEntryRepository?: KnowledgeEntryRepositoryAdapter;
  /**
   * The installation's v2 `decisions` block; `undefined` for v1 or an absent
   * block, which keeps today's deterministic retrieval (decision port plan,
   * invariant 6: off by default).
   */
  readonly decisions?: RankingAdviceDecisions;
  /** Spy transport override for the ranking advice provider (tests only). */
  readonly fetch?: typeof fetch;
  /** Stub key reader override for the ranking advice provider (tests only). */
  readonly readKey?: (path: string) => Promise<string>;
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

  const repo =
    options?.knowledgeEntryRepository ?? new KnowledgeEntryRepositoryAdapter({ stateDir });
  const plainRetrieval = new KnowledgeRetrievalAdapter();
  // Advisory only: the decision port reorders the deterministic set and never
  // changes membership (decision port plan, invariant 1). With no decisions
  // block the advice port is null and the inner result stands unchanged.
  const advice = createRankingAdvice({
    ...(options?.decisions !== undefined ? { decisions: options.decisions } : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    fetch: options?.fetch ?? globalThis.fetch,
    ...(options?.readKey !== undefined ? { readKey: options.readKey } : {}),
  });
  const retrieval = new AdvisedKnowledgeRetrievalAdapter(plainRetrieval, advice);
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
