/**
 * Evidence-and-acceptance supplier composition (SPLIT-1): builds the evidence
 * stack from the shared root inputs; called by the CLI composition root.
 */
import { join } from 'node:path';

import { GH_BINARY_CANDIDATES } from '../gh-binary.js';

import {
  AssessHeadAcceptanceUseCase,
  AttemptOwnerDecisionAdapter,
  createReviewTransportRouter,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  EvidenceSeatPolicyAdapter,
  ForgeEvidenceAdapter,
  hasReviewerSeat,
  IndependentReviewAdapter,
  InspectAcceptanceEvidenceUseCase,
  InspectHeadCiStateUseCase,
  OpenEvidenceAssessmentUseCase,
  OwnerDecisionAdapter,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
  VerificationExecutorAdapter,
} from '@fleet/evidence-and-acceptance';
import type {
  AttemptReviewLocator,
  GhInvocationResult,
  InspectAttemptUseCase,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
} from '@fleet/work-execution';
import {
  defaultOcmRunPath,
  ForgeReadAdapter,
} from '@fleet/work-execution';
import type { FleetInstallationModel } from '@fleet/installation';

import type { FleetCliRuntime, FleetCliRuntimeOptions } from '../composition.js';

export interface ComposeEvidenceInput {
  readonly stateDir?: string;
  readonly roleExecutors: ReturnType<typeof resolveRoleExecutors>;
  readonly options?: FleetCliRuntimeOptions;
  readonly installationModel?: FleetInstallationModel;
  readonly ocmRunBin?: string;
  readonly forgeMode: ReturnType<typeof resolveInstallationForgeMode>;
  readonly coordination: FleetCliRuntime['coordination'];
  readonly runGhSubprocess: (
    args: readonly string[],
    candidates?: readonly string[],
  ) => Promise<GhInvocationResult>;
}

export function composeEvidence(input: ComposeEvidenceInput) {
  const {
    stateDir,
    roleExecutors,
    options,
    installationModel,
    ocmRunBin,
    forgeMode,
    coordination,
    runGhSubprocess,
  } = input;

  // --- evidence-and-acceptance ------------------------------------------------

  const evidenceAssessmentRepository = new EvidenceAssessmentRepositoryAdapter({ stateDir });
  const evidenceArchive = new EvidenceArchiveAdapter({
    archiveDir: stateDir === undefined ? undefined : join(stateDir, 'evidence-archive'),
  });
  // The verification executor runs only allow-listed procedures, locally or
  // over the verifier role's ssh transport; with no installation (and so no
  // allow-list) executed checks report `unknown` until a receipt is recorded
  // by the operator.
  const verificationExecutor = new VerificationExecutorAdapter({
    executor: roleExecutors.verifier,
    allowListedCommands: options?.installation?.verification?.procedures,
  });
  // The reviewer seat comes from the installation's reviewer and
  // high-risk-reviewer chains; with none, requests report "No independent
  // review transport is configured". Independence (a different model family)
  // is enforced by the adapter and use case before any transport runs.
  // The locator needs the work context's attempt repository and recorded-host
  // executors, built below; it is filled in there, and review requests only
  // run after composition finishes.
  const reviewLocatorRef: { locator?: AttemptReviewLocator } = {};
  const reviewSeats = installationModel?.seats ?? [];
  const reviewChains = installationModel?.chains;
  let independentReview: IndependentReviewAdapter;
  if (hasReviewerSeat(reviewSeats, reviewChains)) {
    independentReview = new IndependentReviewAdapter({
      runReview: createReviewTransportRouter({
        seats: reviewSeats,
        chains: reviewChains,
        locate: async (attemptId) => {
          const locator = reviewLocatorRef.locator;
          if (locator === undefined) {
            throw new Error('The work context is not wired for review location');
          }
          return locator.locate(attemptId);
        },
        ocmRunBin: ocmRunBin ?? defaultOcmRunPath(),
        ...(options?.reviewSpawn !== undefined ? { ocmSpawn: options.reviewSpawn } : {}),
      }),
    });
  } else {
    independentReview = new IndependentReviewAdapter();
  }
  // Free-seat flag (F5): a structural subset of the derived model; absent
  // installation or flag means allowed.
  const seatPolicy = new EvidenceSeatPolicyAdapter({
    useFreeSeats: installationModel?.policy?.useFreeSeats,
    seats: installationModel?.seats,
  });
  // Instantiated for the station that binds a live forge transport. With
  // forge mode `github` (D6) it is bound to AssessHeadAcceptanceUseCase with
  // the installation's owner/repo; with mode `none` acceptance is
  // receipt-only and records `forgeEvidence: 'not-configured'`; with no forge
  // section the CLI keeps today's receipt-only behaviour.
  const forgeSection =
    installationModel?.forge !== undefined && 'mode' in installationModel.forge
      ? installationModel.forge
      : undefined;
  const forgeGithubSection =
    forgeSection?.mode === 'github' ? forgeSection : undefined;
  // The argument-array gh runner shared with the forge action adapter (D6):
  // mode `github` hands it to the forge-evidence adapter so reads can
  // succeed; tests inject a stub transport through the runtime options.
  const ghBinaryCandidates = options?.ghBinaryCandidates ?? GH_BINARY_CANDIDATES;
  const forgeGhRunner =
    options?.forgeGhRunner ??
    ((args: readonly string[]) => runGhSubprocess(args, ghBinaryCandidates));
  const forgeEvidence =
    forgeMode === 'github'
      ? new ForgeEvidenceAdapter({
          owner: forgeGithubSection?.owner,
          repo: forgeGithubSection?.repo,
          runGh: forgeGhRunner,
        })
      : new ForgeEvidenceAdapter();
  // AM4b-2: the read-only PR-state read (auto-merge A13, conductor reconcile)
  // shares the forge-evidence runner and the installation's owner/repo. Any
  // other mode leaves it unconfigured, so every read is `unavailable`.
  const forgeRead =
    forgeMode === 'github'
      ? new ForgeReadAdapter({
          owner: forgeGithubSection?.owner,
          repo: forgeGithubSection?.repo,
          runGh: forgeGhRunner,
        })
      : new ForgeReadAdapter();
  const ownerDecision = new OwnerDecisionAdapter({
    checkOwnerDecision: async (request) => {
      const result = await coordination.checkOwnerDecision.checkOwnerDecision({
        requestId: request.requestId,
        candidateHeadSha: request.candidateHeadSha,
      });
      return result.outcome === 'approved'
        ? { outcome: 'approved', decisionId: result.requestId }
        : result;
    },
  });
  // The doors an attempt must clear are read from its own record, which
  // dispatch wrote from the frozen brief package. The attempt lookup is
  // captured here and filled in once the work composition exists below.
  const attemptLookup: { inspectAttempt?: InspectAttemptUseCase } = {};
  const attemptOwnerDecision = new AttemptOwnerDecisionAdapter({
    readAttemptOwnerDecisionReferences: async (request) => {
      const inspectAttempt = attemptLookup.inspectAttempt;
      if (!inspectAttempt) {
        return {
          outcome: 'unknown',
          reason: 'The work context is not wired for attempt inspection',
        };
      }
      const inspection = await inspectAttempt.inspectAttempt({
        attemptId: request.attemptId,
      });
      if (inspection.outcome !== 'found') {
        return {
          outcome: 'unknown',
          reason: `No attempt is recorded for ${request.attemptId}`,
        };
      }
      const recorded = inspection.attempt.ownerDecisionReferences;
      if (recorded === undefined) {
        return {
          outcome: 'unknown',
          reason: `attempt ${request.attemptId} was recorded before owner decision references were frozen`,
        };
      }
      return { outcome: 'recorded', ownerDecisionReferences: recorded };
    },
  });

  const evidence = {
    evidenceAssessmentRepository,
    evidenceArchive,
    verificationExecutor,
    independentReview,
    forgeEvidence,
    ownerDecision,
    attemptOwnerDecision,
    requestVerification: new RequestVerificationUseCase({
      repo: evidenceAssessmentRepository,
      executor: verificationExecutor,
      archive: evidenceArchive,
    }),
    requestIndependentReview: new RequestIndependentReviewUseCase({
      repo: evidenceAssessmentRepository,
      reviewer: independentReview,
      archive: evidenceArchive,
      seatPolicy,
    }),
    openEvidenceAssessment: new OpenEvidenceAssessmentUseCase({
      repo: evidenceAssessmentRepository,
    }),
    recordVerificationReceipt: new RecordVerificationReceiptUseCase({
      repo: evidenceAssessmentRepository,
    }),
    recordReviewReceipt: new RecordReviewReceiptUseCase({
      repo: evidenceAssessmentRepository,
      seatPolicy,
    }),
    recordFindingDisposition: new RecordFindingDispositionUseCase({
      repo: evidenceAssessmentRepository,
    }),
    assessHeadAcceptance: new AssessHeadAcceptanceUseCase({
      repo: evidenceAssessmentRepository,
      // Forge mode `github` binds the forge-evidence port in this root too
      // (D6); mode `none` records receipt-only acceptance as not-configured.
      ...(forgeMode === 'github' ? { forgeEvidence } : {}),
      ...(forgeMode === 'none' ? { forgeMode: 'none' as const } : {}),
      ownerDecisionPort: ownerDecision,
      attemptOwnerDecisionPort: attemptOwnerDecision,
    }),
    inspectAcceptanceEvidence: new InspectAcceptanceEvidenceUseCase({
      repo: evidenceAssessmentRepository,
    }),
    // Forge mode `github` only, as for assessHeadAcceptance; otherwise every
    // head answers unknown / not-configured.
    inspectHeadCiState: new InspectHeadCiStateUseCase(
      forgeMode === 'github' ? { forgeEvidence } : {},
    ),
  };

  return {
    evidence,
    reviewLocatorRef,
    attemptLookup,
    forgeRead,
    ghBinaryCandidates,
    forgeGithubSection,
    ownerDecision,
    attemptOwnerDecision,
  };
}
