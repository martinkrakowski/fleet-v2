/**
 * Brief-knowledge supplier composition (SPLIT-1): builds the knowledge stack
 * from the shared root inputs; called by the CLI composition root.
 */
import {
  AdvisedKnowledgeRetrievalAdapter,
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  ClaimVerificationAdapter,
  createClaimTriage,
  createRankingAdvice,
  DecideKnowledgeDispositionUseCase,
  type DecisionReceiptJournalPort,
  FileDecisionReceiptJournalAdapter,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
  ListCandidateClaimsUseCase,
  NotConfiguredReceiptJournal,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from '@fleet/brief-knowledge';

import type { FleetCliRuntimeOptions } from '../composition.js';

export interface ComposeKnowledgeInput {
  readonly stateDir?: string;
  readonly options?: FleetCliRuntimeOptions;
}

export function composeKnowledge(input: ComposeKnowledgeInput) {
  const { stateDir, options } = input;

  // --- brief-knowledge -------------------------------------------------------

  const knowledgeEntryRepository = new KnowledgeEntryRepositoryAdapter({ stateDir });
  // Bounded, allow-listed procedures only; the claim text is never interpreted.
  const claimVerification = new ClaimVerificationAdapter();
  const keeperPublication = new KeeperPublicationAdapter({ stateDir });
  const knowledgeRetrieval = new KnowledgeRetrievalAdapter();
  // Advisory only (decision port plan): the installation's v2 decisions block
  // (v1 files never carry one) drives an advice port that reorders the
  // deterministic retrieval set; with no block the advice port is null and the
  // inner result stands unchanged. Proposals flow through ProposeBriefContext
  // only; the key never enters argv, env or logs.
  const rankingAdvice = createRankingAdvice({
    ...(options?.installation?.decisions !== undefined
      ? { decisions: options.installation.decisions }
      : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    fetch: options?.adviceFetch ?? globalThis.fetch,
    ...(options?.adviceReadKey !== undefined ? { readKey: options.adviceReadKey } : {}),
  });
  const advisedRetrieval = new AdvisedKnowledgeRetrievalAdapter(
    knowledgeRetrieval,
    rankingAdvice,
  );
  // Candidate-claim triage (K6): the same decisions block, key source and
  // receipt journal the ranking advice uses. The factory returns undefined
  // unless the block is enabled, a key source is declared, the claim-triage
  // consumer carries `acknowledgeCandidateClaimsLeaveHost: true` and a fetch
  // was injected — triage stays off otherwise and capture is unchanged.
  const claimTriage = createClaimTriage({
    ...(options?.installation?.decisions !== undefined
      ? { decisions: options.installation.decisions }
      : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    fetch: options?.adviceFetch ?? globalThis.fetch,
    ...(options?.adviceReadKey !== undefined ? { readKey: options.adviceReadKey } : {}),
  });
  // The decision receipt journal (K4): the same `<stateDir>/decision-receipts`
  // store the ranking advice adapter writes. With no state dir nothing was
  // ever reserved or settled, so the unconfigured journal answers reads with
  // an empty snapshot and the selection outcome is skipped silently.
  const decisionReceiptJournal: DecisionReceiptJournalPort =
    stateDir === undefined || stateDir.trim().length === 0
      ? new NotConfiguredReceiptJournal()
      : new FileDecisionReceiptJournalAdapter(stateDir);

  const knowledge = {
    knowledgeEntryRepository,
    claimVerification,
    keeperPublication,
    knowledgeRetrieval,
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase({
      repo: knowledgeEntryRepository,
      ...(claimTriage !== undefined ? { triage: claimTriage } : {}),
    }),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase({
      repo: knowledgeEntryRepository,
      verifier: claimVerification,
    }),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase({
      repo: knowledgeEntryRepository,
    }),
    listCandidateClaims: new ListCandidateClaimsUseCase({
      repo: knowledgeEntryRepository,
    }),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase({
      repo: knowledgeEntryRepository,
      publisher: keeperPublication,
    }),
    proposeBriefContext: new ProposeBriefContextUseCase({
      repo: knowledgeEntryRepository,
      retrieval: advisedRetrieval,
    }),
    recordContextSelection: new RecordContextSelectionUseCase({
      repo: knowledgeEntryRepository,
      // The selection outcome joins the ranking receipt the proposals named
      // (K4); best effort by contract, never failing the recording.
      journal: decisionReceiptJournal,
    }),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase({ repo: knowledgeEntryRepository }),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase({ repo: knowledgeEntryRepository }),
    decisionReceiptJournal,
  };

  return { knowledge };
}
