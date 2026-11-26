/**
 * Conductor composition (SPLIT-2): builds the conductor object from the shared
 * root inputs; called by the CLI composition root.
 */
import { newUlid } from '../ulid.js';
import { autoMergeSettingsFromLoad } from '../auto-merge-settings.js';

import {
  ActionAuthorizationAdapter,
  AttemptRepositoryAdapter,
  AttemptArtifactAdapter,
  ConductorForgeGrantAdapter,
  LaneRunParkNoticeAdapter,
  CiStateAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  ConductorPassTraceAdapter,
  ExecutionJournalAdapter,
  GateFailingFileAdapter,
  GateReceiptAdapter,
  InspectLaneRunsUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  ListConductorPassesUseCase,
  ListLaneRunsUseCase,
  ListStalledRunsUseCase,
  StallAttentionAdapter,
  ReapLaneWorktreesUseCase,
  ReapOrphanReservationsUseCase,
  ReapOrphanSessionsUseCase,
  ReapZombiesUseCase,
  ReaperFindingRepositoryAdapter,
  InMemoryReaperFindingRepositoryAdapter,
  AuthorityEventJournalAdapter,
  RequestLaneRunStopUseCase,
  ResumeLaneRunUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  WorkspaceAdapter,
  WorkOrderRepositoryAdapter,
  sha256HexDigest,
  isCalendarDateTime,
  snapshotPlainDataRecord,
  unsealedWorktreeRemovalActionId,
  unsealedWorktreeRemovalScope,
  consumptionId,
  type AuthorizeUnsealedWorktreeRemovalRequest,
  type AuthorizeUnsealedWorktreeRemovalResult,
  type ExecutionRunnerPort,
  type ForgeReadAdapter,
  type MergeRecordRepositoryAdapter,
  type ProjectProfileReadPort,
  type ReconcileAttemptUseCase,
  type RunnerForAttemptPort,
  withStopAuthorityEvents,
} from '@fleet/work-execution';
import type { CoordinationRequestRepositoryAdapter } from '@fleet/operator-coordination';

import {
  DEFAULT_MERGE_DAEMON_POLICY,
  conductorRevision,
  deriveInstallationModel,
  resolveConductorPolicy,
  resolveMergePolicy,
} from '@fleet/installation';
import {
  assessmentIdForAttempt,
  reviewerChainSeatIds,
  selectReviewerSeat,
} from '@fleet/evidence-and-acceptance';

import type { FleetCliRuntime } from '../composition.js';
import type { FleetInstallation, LoadResult } from '@fleet/installation';
import type {
  AskOwnerQuestionRequest,
  IssuePolicyForgeGrantUseCase,
} from '@fleet/operator-coordination';

export interface ComposeConductorInput {
  readonly stateDir?: string;
  readonly evidence: FleetCliRuntime['evidence'];
  readonly profileRead: ProjectProfileReadPort;
  /** The attention and owner-question use cases the park notices delegate to (K6-3). */
  readonly coordination: Pick<
    FleetCliRuntime['coordination'],
    | 'recordAttentionItem'
    | 'clearAttentionItem'
    | 'listAttentionItems'
    | 'listProjectProfiles'
    | 'askOwnerQuestion'
    | 'syncOneWayOwnerQuestions'
    | 'listOwnerQuestions'
    | 'resolveActionAuthorization'
    | 'recordAuthorizationConsumption'
  >;
  /** C2': the artifact adapter whose fail-closed manifest check backs the reap. */
  readonly attemptArtifact: AttemptArtifactAdapter;
  /** C2': the coordination requests the `--force-unsealed` approval binds to. */
  readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
  /** The policy grant issuer behind the conductor's own push grants (K6-2). */
  readonly issuePolicyForgeGrantUseCase: IssuePolicyForgeGrantUseCase;
  /** A fresh installation loader for the auto-merge setting read (AM5-3). */
  readonly autoMergeLoad: () => LoadResult;
  /** The parsed installation the conductor revision is resolved from. */
  readonly installation?: FleetInstallation;
  /** The execution stores the worktree reap reads (EX-2b). */
  readonly workOrderRepository: WorkOrderRepositoryAdapter;
  readonly attemptRepository: AttemptRepositoryAdapter;
  /** R4a: the read-only forge read the settled open-pr park's resume re-checks. */
  readonly forgeRead: ForgeReadAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly workspace: WorkspaceAdapter;
  /** H9b1: resolves the runner addressed by an attempt's recorded host (EX-4). */
  readonly runnerForAttempt: RunnerForAttemptPort;
  /** The conductor's own run-reconciliation use case (KW4b'). */
  readonly reconcileAttempt: ReconcileAttemptUseCase;
  /** The merge-record store behind the reaper's merged-worktree evidence. */
  readonly mergeRecordRepository: MergeRecordRepositoryAdapter;
  /** The direct runner port, for the reaper's worktree holds and checks. */
  readonly runner: ExecutionRunnerPort;
}

export function composeConductor(input: ComposeConductorInput) {
  const {
    stateDir,
    evidence,
    profileRead,
    coordination,
    attemptArtifact,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    autoMergeLoad,
    installation,
    workOrderRepository,
    attemptRepository,
    forgeRead,
    executionJournal,
    workspace,
    runnerForAttempt,
    reconcileAttempt,
    mergeRecordRepository,
    runner,
  } = input;

  // K7: the conductor's stores and its record-only controls. Nothing here
  // dispatches.
  const laneRunRepository = new LaneRunRepositoryAdapter({ stateDir });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir });
  const conductorDriverLease = new ConductorDriverLeaseAdapter({ stateDir });
  const conductorHalt = new ConductorHaltAdapter({ stateDir });
  // The pass-trace ring: the live driver appends to it (with limits) and the
  // read side here has no limits — listing and the schedule's cap read it.
  const conductorPassTraces = new ConductorPassTraceAdapter({ stateDir });
  const conductorNewUlid = () => newUlid();
  // The auto-merge setting is read once at composition; a toggle takes a
  // restart (K6-8). An unreadable setting fails closed.
  let autoMergeEnabled = false;
  try {
    const settings = autoMergeSettingsFromLoad(autoMergeLoad());
    autoMergeEnabled = settings.outcome === 'read' && settings.enabled;
  } catch {
    autoMergeEnabled = false;
  }
  // The review request adapter, shared by the review step and the status view's
  // read-only findings projection (GB2). Hoisted above the conductor literal so
  // today the inspect use case can read the parked head's latest receipt.
  // D1C fix round 2: the adapter's opencode fallback keys off the api reviewer
  // seat's model (the api-route guard) and the opencode reviewer seat's model
  // (the fallback seat), so the composed delegates carry both, derived from the
  // installation's reviewer chains through the review transport router's
  // model-specific seat selection (chain order, duplicates dropped). Whenever
  // the reviewer chains contain one or more distinct api reviewer models, each
  // api model routes its fallback to the opencode reviewer seat; without any
  // api reviewer seat neither value is set and the fallback stays off — the
  // fail-closed default, not a silent degradation.
  const derivedInstallation =
    installation !== undefined ? deriveInstallationModel(installation).model : undefined;
  const installationSeats = derivedInstallation?.seats ?? installation?.seats ?? [];
  const installationChains = derivedInstallation?.chains ?? installation?.chains;
  const reviewerChainSeatIdList = reviewerChainSeatIds(installationChains);
  const reviewerSeats = reviewerChainSeatIdList
    .map((id) => installationSeats.find((seat) => seat.id === id))
    .filter((seat): seat is NonNullable<typeof seat> => seat !== undefined);
  const apiReviewerModels: string[] = [];
  for (const seat of reviewerSeats) {
    if (seat.tool !== 'api' || apiReviewerModels.includes(seat.model)) {
      continue;
    }
    const selected = selectReviewerSeat(installationSeats, installationChains, seat.model);
    if (selected.ok && selected.seat.tool === 'api') {
      apiReviewerModels.push(selected.seat.model);
    }
  }
  const isSelectableOpencodeSeat = (
    seat: (typeof reviewerSeats)[number],
    apiModel: string,
  ): boolean => {
    if (seat.tool !== 'opencode' || seat.model === apiModel) {
      return false;
    }
    const selected = selectReviewerSeat(installationSeats, installationChains, seat.model);
    return selected.ok && selected.seat.tool === 'opencode';
  };
  const opencodeFallbackModelFor = (apiModel: string): string | undefined => {
    const chainList = [installationChains?.reviewer, installationChains?.['high-risk-reviewer']];
    for (const chain of chainList) {
      if (chain === undefined) {
        continue;
      }
      const chainSeats = chain
        .map((step) => installationSeats.find((seat) => seat.id === step.seatId))
        .filter((seat): seat is NonNullable<typeof seat> => seat !== undefined);
      if (!chainSeats.some((seat) => seat.tool === 'api' && seat.model === apiModel)) {
        continue;
      }
      const sameChainFallback = chainSeats.find((seat) => isSelectableOpencodeSeat(seat, apiModel));
      if (sameChainFallback !== undefined) {
        return sameChainFallback.model;
      }
    }
    return reviewerSeats.find((seat) => isSelectableOpencodeSeat(seat, apiModel))?.model;
  };
  const baseReviewRequestDelegates = {
    requestIndependentReview: (
      request: Parameters<typeof evidence.requestIndependentReview.requestIndependentReview>[0],
    ) => evidence.requestIndependentReview.requestIndependentReview(request),
    inspectAcceptanceEvidence: (
      request: Parameters<typeof evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence>[0],
    ) => evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence(request),
    // KF-33b2: the review step's out-of-scope dispositions through the
    // evidence context's existing disposition use case, one id per call.
    recordFindingDisposition: (
      request: Parameters<typeof evidence.recordFindingDisposition.recordFindingDisposition>[0],
    ) => evidence.recordFindingDisposition.recordFindingDisposition(request),
    // RV4: screen and archive a busy-transport diagnostic under the review
    // request id; an archive miss never changes the review outcome.
    archiveEvidence: (request: Parameters<typeof evidence.evidenceArchive.archiveEvidence>[0]) =>
      evidence.evidenceArchive.archiveEvidence(request),
    // BL04: the attempt repository read a brief-check's briefText binding
    // checks the recorded frozen-brief digest against.
    findAttemptById: (attemptId: string) => attemptRepository.findAttemptById(attemptId),
  };
  const primaryApiReviewerModel = apiReviewerModels[0];
  const opencodeFallbackReviewerModel =
    primaryApiReviewerModel === undefined
      ? undefined
      : opencodeFallbackModelFor(primaryApiReviewerModel);
  const reviewRequest = new ReviewRequestAdapter({
    ...baseReviewRequestDelegates,
    // D1C fix round 2: the composed fallback route — only a request whose
    // primary reviewer is an api seat's model retries once against the
    // opencode reviewer seat's model; without an api reviewer seat neither
    // is set and no fallback runs.
    ...(primaryApiReviewerModel !== undefined ? { primaryApiReviewerModel } : {}),
    ...(opencodeFallbackReviewerModel !== undefined ? { opencodeFallbackReviewerModel } : {}),
  });
  if (apiReviewerModels.length > 1) {
    const reviewRequestByApiModel = new Map<string, ReviewRequestAdapter>();
    for (const apiModel of apiReviewerModels) {
      const fallback = opencodeFallbackModelFor(apiModel);
      reviewRequestByApiModel.set(
        apiModel,
        new ReviewRequestAdapter({
          ...baseReviewRequestDelegates,
          primaryApiReviewerModel: apiModel,
          ...(fallback !== undefined ? { opencodeFallbackReviewerModel: fallback } : {}),
        }),
      );
    }
    const defaultRequestReview = reviewRequest.requestReview.bind(reviewRequest);
    reviewRequest.requestReview = (request) => {
      let requestedModel: unknown;
      try {
        if (typeof request === 'object' && request !== null) {
          requestedModel = Object.getOwnPropertyDescriptor(request, 'reviewerModel')?.value;
        }
      } catch {
        requestedModel = undefined;
      }
      if (typeof requestedModel === 'string') {
        const selected = selectReviewerSeat(
          installationSeats,
          installationChains,
          requestedModel,
        );
        if (selected.ok && selected.seat.tool === 'api') {
          const perModelAdapter = reviewRequestByApiModel.get(selected.seat.model);
          if (perModelAdapter !== undefined) {
            return perModelAdapter.requestReview(request);
          }
        }
      }
      return defaultRequestReview(request);
    };
  }

  // C2': the scoped one-way owner approval behind the reap's
  // `--force-unsealed`, built from the coordination stack.
  const unsealedRemovalAuthorization = new ActionAuthorizationAdapter({
    authorizeUnsealedWorktreeRemoval: unsealedWorktreeRemovalAuthorizer({
      coordination,
      coordinationRequestRepository,
    }),
  });

  // PT1a: `policy.daemon.stallAfterMinutes`, read once at composition like the
  // auto-merge setting; an unreadable merge policy falls back to the default.
  const mergePolicy = resolveMergePolicy(installation?.policy);
  const stallAfterMinutes =
    mergePolicy.outcome === 'resolved'
      ? mergePolicy.daemon.stallAfterMinutes
      : DEFAULT_MERGE_DAEMON_POLICY.stallAfterMinutes;

  // KW4b': the zombie reaper's findings store (file-backed with a state dir,
  // in-memory otherwise) and its attention/merge-evidence delegates.
  const reaperFindingRepository =
    stateDir !== undefined
      ? new ReaperFindingRepositoryAdapter({ stateDir })
      : new InMemoryReaperFindingRepositoryAdapter();

  // The coordination attention store keeps worktree subjects as `wt-<12 hex>`
  // and host subjects as `host-<12 hex>` (project kind); the reaper's subject
  // digests are normalized to that shape on record and clear.
  const normalizeReaperSubject = (subject: unknown): unknown => {
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) {
      return subject;
    }
    const record = subject as { readonly kind?: unknown; readonly ref?: unknown };
    if (record.kind === 'worktree' && typeof record.ref === 'string') {
      return { kind: 'worktree', ref: record.ref.startsWith('wt-') ? record.ref : 'wt-' + record.ref };
    }
    if (record.kind === 'host' && typeof record.ref === 'string') {
      return { kind: 'project', ref: record.ref.startsWith('host-') ? record.ref : 'host-' + record.ref };
    }
    return subject;
  };
  const reaperAttention = {
    listAttentionItems: (request: { readonly projectId?: string }) =>
      coordination.listAttentionItems.listAttentionItems(request),
    recordAttentionItem: async (body: unknown, actor: string) => {
      const candidate = (body ?? {}) as Record<string, unknown>;
      const result = await coordination.recordAttentionItem.recordAttentionItem(
        { ...candidate, subject: normalizeReaperSubject(candidate['subject']) },
        actor,
      );
      return { outcome: result.outcome };
    },
    clearAttentionItem: (request: unknown, via: string, actor: string) => {
      const candidate = (request ?? {}) as Record<string, unknown>;
      return coordination.clearAttentionItem.clearAttentionItem(
        { ...candidate, subject: normalizeReaperSubject(candidate['subject']) },
        via as 'cli' | 'web' | 'machine',
        actor,
      );
    },
  };

  // The merge-record read the merged-worktree evidence uses: a record whose
  // repository is the lane-run branch (`fleet/<runId>`) answers `merged-pr`
  // without a forge read; anything else falls through to the forge.
  const reaperMergeRecordRead = {
    findByProjectAndBranch: async (_projectId: string, branch: string) => {
      const records = await mergeRecordRepository.listMergeRecords();
      for (const record of records) {
        if (record.repository === branch) {
          return record;
        }
      }
      return null;
    },
  };

  const conductor = {
    stallAfterMinutes,
    laneRunRepository,
    laneRunJournal,
    driverLease: conductorDriverLease,
    halt: conductorHalt,
    // FC12B fix round 2: the CLI's real stop requests emit their authority
    // audit event through the state-dir journal sink; the audited wrapper's
    // `auditGap` flag is surfaced by the stop command's own boundary.
    requestLaneRunStop: withStopAuthorityEvents(
      new RequestLaneRunStopUseCase({
        runRepo: laneRunRepository,
        runJournal: laneRunJournal,
      }),
      new AuthorityEventJournalAdapter(
        stateDir === undefined ? {} : { stateDir },
      ),
      { actor: 'cli', organizationId: null },
    ),
    inspectLaneRuns: new InspectLaneRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
      attemptRepo: attemptRepository,
      reviewReceipts: reviewRequest,
      executionJournal,
    }),
    // PT1a (SN3): `conductor status --stalled`, over the same stores and threshold as the pass.
    listStalledRuns: new ListStalledRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      stallAfterMinutes,
    }),
    // PT1a (SN2): the pass raises, refreshes and clears one `stall:<runId>` item per stalled run.
    stallAttention: new StallAttentionAdapter({
      recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
      clearAttentionItem: (request, via, actor) =>
        coordination.clearAttentionItem.clearAttentionItem(
          request as Parameters<typeof coordination.clearAttentionItem.clearAttentionItem>[0],
          via as 'cli' | 'web' | 'machine',
          actor,
        ),
      listAttentionItems: (request) => coordination.listAttentionItems.listAttentionItems(request),
    }),
    // PT1a: the failing gate file a verification receipt recorded, read to class a gate park.
    gateFailingFile: new GateFailingFileAdapter({
      inspector: {
        inspectAcceptanceEvidence: (request) =>
          evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence(request),
      },
    }),
    listLaneRuns: new ListLaneRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
      attemptRepo: attemptRepository,
      executionJournal,
      workOrderRepo: workOrderRepository,
      passTrace: conductorPassTraces,
    }),
    listConductorPasses: new ListConductorPassesUseCase({ passTrace: conductorPassTraces }),
    resumeLaneRun: new ResumeLaneRunUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      newUlid: conductorNewUlid,
      forgeRead,
      attemptRepo: attemptRepository,
      worktreeInspect: workspace,
    }),
    // EX-2b: the operator-opt-in worktree reap, built beside the lane-run
    // stores it scans and the execution stores it journals to. C2': the
    // removal is gated on the sealed artifact manifest, and `--force-unsealed`
    // consumes a scoped one-way owner approval through the coordination stack.
    reapLaneWorktrees: new ReapLaneWorktreesUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      executionJournal,
      profileRead,
      workspace,
      attemptArtifact,
      actionAuthorization: unsealedRemovalAuthorization,
      runnerForAttempt,
      computeDigest: sha256HexDigest,
    }),
    // EX-4: the operator-opt-in orphan-session reap, built beside the worktree
    // reap from the execution stores it scans and the per-host runner resolver.
    reapOrphanSessions: new ReapOrphanSessionsUseCase({
      attemptRepo: attemptRepository,
      executionJournal,
      runnerForAttempt,
    }),
    // OG22b: the adapters are passed whole; the use case calls the fenced
    // release as a method of the journal adapter.
    reapOrphanReservations: new ReapOrphanReservationsUseCase({
      executionJournal,
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      attemptRepo: attemptRepository,
      newUlid: conductorNewUlid,
    }),
    // OG22b: a dry run reads through read-only stores, so an unreadable state
    // file is a read error and is never quarantined by a listing.
    reapOrphanReservationsDryRun: new ReapOrphanReservationsUseCase({
      executionJournal: new ExecutionJournalAdapter({ stateDir, readOnly: true }),
      runRepo: new LaneRunRepositoryAdapter({ stateDir, readOnly: true }),
      runJournal: new LaneRunJournalAdapter({ stateDir, readOnly: true }),
      attemptRepo: new AttemptRepositoryAdapter({ stateDir, readOnly: true }),
      newUlid: conductorNewUlid,
    }),
    // KW4b': the zombie reaper pass. The merged-worktree removal is opt-in
    // behind `policy.conductor.reaper.repairs['merged-worktree']` (D-R6).
    reapZombies: new ReapZombiesUseCase({
      attemptRepo: attemptRepository,
      executionJournal,
      runJournal: laneRunJournal,
      runRepo: laneRunRepository,
      halt: conductorHalt,
      reconcile: reconcileAttempt,
      mergeRecordRepo: reaperMergeRecordRead,
      runner,
      runnerForAttempt,
      attention: reaperAttention,
      reaperFindings: reaperFindingRepository,
      newId: conductorNewUlid,
      workspace,
      profiles: {
        listProjectProfiles: (request: { readonly status?: 'active' | 'retired' }) =>
          coordination.listProjectProfiles.listProjectProfiles(request),
      },
      forgeRead,
      // The reaper's subjects are 12-hex digests (D1); the full sha256 is
      // truncated to that shape.
      computeDigest: (text) => sha256HexDigest(text).slice(0, 12),
    }),
    reaperFindingRepository,
    newUlid: conductorNewUlid,
    profileRead,
    // Delegates are bound as arrow functions: the use cases read `this.deps`,
    // so an unbound method call would fail every request.
    reviewRequest,
    reviewAssessment: new ReviewAssessmentAdapter({
      openEvidenceAssessment: (request) =>
        evidence.openEvidenceAssessment.openEvidenceAssessment(request),
    }),
    // The conducted gate's verification receipts (KF-13): one per acceptance
    // check at the collected head, into the assessment the gate opens first.
    gateReceipts: new GateReceiptAdapter({
      recordVerificationReceipt: (request) =>
        evidence.recordVerificationReceipt.recordVerificationReceipt(request),
      assessmentIdOf: assessmentIdForAttempt,
    }),
    ciState: new CiStateAdapter({
      inspectHeadCiState: (request) => evidence.inspectHeadCiState.inspectHeadCiState(request),
    }),
    // The conductor's own push grant issuer (K6-2): a `policy:conductor@<rev>`
    // grant through the root's policy grant use case; the merge itself is
    // never a conductor grant.
    conductorForgeGrant: new ConductorForgeGrantAdapter({
      issue: (request) => issuePolicyForgeGrantUseCase.issuePolicyForgeGrant(request),
      conductorRevision: () => conductorRevision(resolveConductorPolicy(installation?.policy)),
    }),
    // Park notices (K6-3): attention items and keyed owner questions through
    // the coordination use cases; no find-by-key use case is composed, so the
    // question read stays unbound.
    parkNotice: new LaneRunParkNoticeAdapter({
      recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
      askOwnerQuestion: (request) =>
        coordination.askOwnerQuestion.askOwnerQuestion(request as AskOwnerQuestionRequest),
    }),
    autoMergeEnabled,
  };

  return { conductor };
}

/** The coordination surface the `--force-unsealed` approval is built from. */
export interface UnsealedRemovalAuthorizerDeps {
  readonly coordination: Pick<
    FleetCliRuntime['coordination'],
    | 'syncOneWayOwnerQuestions'
    | 'listOwnerQuestions'
    | 'resolveActionAuthorization'
    | 'recordAuthorizationConsumption'
  >;
  readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
}

/** The scoped values one candidate question/consumer pairing is evaluated against. */
interface UnsealedRemovalScope {
  readonly projectId: string;
  readonly actionId: string;
  readonly actionScope: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly nowIso: string;
}

/** The non-null request record `findRequestById` can return. */
type CoordinationRequestSnapshot = Exclude<
  Awaited<ReturnType<CoordinationRequestRepositoryAdapter['findRequestById']>>,
  null
>;

/**
 * True when the single stored receipt names exactly this action id and
 * attempt: the crash-recovery shape. The stored receipt alone is never
 * authority; it only selects the verified replay path.
 */
function isCrashRecoveryConsumption(
  coordReq: CoordinationRequestSnapshot,
  scope: UnsealedRemovalScope,
): boolean {
  const consumption = coordReq.consumptions[0];
  return (
    coordReq.consumptions.length === 1 &&
    consumption !== undefined &&
    consumption.actionId === scope.actionId &&
    consumption.attemptId === scope.attemptId &&
    coordReq.grantId !== null
  );
}

/**
 * C2': the scoped one-way owner approval behind the reap's
 * `--force-unsealed`. The delegate matches an answered one-way owner question
 * to a coordination request bound to the exact project, action scope
 * (attempt + worktree-path digest) and head, then consumes its grant exactly
 * once; a prior consumption of the same action id and attempt is the crash
 * recovery, not a second authorization. Nothing here logs a request, grant or
 * filesystem path.
 */
export function unsealedWorktreeRemovalAuthorizer(
  deps: UnsealedRemovalAuthorizerDeps,
): (
  request: AuthorizeUnsealedWorktreeRemovalRequest,
) => Promise<AuthorizeUnsealedWorktreeRemovalResult> {
  const { coordination, coordinationRequestRepository } = deps;
  return async (rawRequest) => {
    const request = readAuthorizerRequest(rawRequest);
    if (request === null) {
      return { outcome: 'blocked', reason: 'invalid-request' };
    }
    const scope = readUnsealedRemovalScope(request);
    try {
      return await authorizeUnsealedRemovalWithScope(
        coordination,
        scope,
        coordinationRequestRepository,
      );
    } catch {
      return { outcome: 'unknown', reason: 'owner-question-sync-failed' };
    }
  };
}

/** The scoped values one candidate question/consumer pairing is evaluated against. */
function readUnsealedRemovalScope(
  request: AuthorizeUnsealedWorktreeRemovalRequest,
): UnsealedRemovalScope {
  const { projectId, runId, attemptId, worktreePath, expectedHeadSha, nowIso } = request;
  return {
    projectId,
    actionId: unsealedWorktreeRemovalActionId(runId, attemptId),
    actionScope: unsealedWorktreeRemovalScope(attemptId, sha256HexDigest(worktreePath)),
    attemptId,
    expectedHeadSha,
    nowIso,
  };
}

/**
 * The owner-approval scan for one removal request: sync the one-way owner
 * questions, select the candidates bound to this exact scope, and authorize
 * the first candidate that yields a verified approval.
 */
async function authorizeUnsealedRemovalWithScope(
  coordination: UnsealedRemovalAuthorizerDeps['coordination'],
  scope: UnsealedRemovalScope,
  coordinationRequestRepository: CoordinationRequestRepositoryAdapter,
): Promise<AuthorizeUnsealedWorktreeRemovalResult> {
  const synced = await syncOwnerQuestions(coordination);
  if (!synced.ok) {
    return { outcome: 'unknown', reason: synced.reason };
  }
  const result = await authorizeSelectedQuestions(
    coordination,
    scope,
    selectOwnerQuestions(synced.questions, scope, coordinationRequestRepository),
  );
  if (result === null) {
    return { outcome: 'blocked', reason: 'no-scoped-owner-approval' };
  }
  return result;
}

/** The synced question list, or the `unknown` reason it could not be read. */
type SyncedOwnerQuestions =
  | { readonly ok: true; readonly questions: readonly unknown[] }
  | {
      readonly ok: false;
      readonly reason: 'owner-question-sync-failed' | 'owner-question-list-too-large';
    };

/**
 * Sync the one-way owner questions and return the listed questions; `ok:
 * false` when the listing is not a bounded array (the caller answers
 * `unknown` with the same reason).
 */
async function syncOwnerQuestions(
  coordination: UnsealedRemovalAuthorizerDeps['coordination'],
): Promise<SyncedOwnerQuestions> {
  await coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions();
  const listed = await coordination.listOwnerQuestions.listOwnerQuestions();
  const questions: unknown = isRecordObject(listed) ? listed['questions'] : undefined;
  if (!Array.isArray(questions)) {
    return { ok: false, reason: 'owner-question-sync-failed' };
  }
  if (questions.length > MAX_OWNER_QUESTIONS_SCAN) {
    return { ok: false, reason: 'owner-question-list-too-large' };
  }
  return { ok: true, questions };
}

/** One matched question/request pairing the removal is authorized against. */
interface SelectedOwnerQuestion {
  readonly question: { readonly questionId: string; readonly linkedRequestId: string };
  readonly coordReq: CoordinationRequestSnapshot;
}

/**
 * The answered one-way owner questions whose linked coordination request is
 * bound to this exact removal scope (project, action scope, head, no policy
 * grant). A sparse array's hole is skipped, never read as a question.
 *
 * Yields lazily, in question order: each lookup happens only when the
 * consumer asks for the next candidate, so a rejection from a later
 * question's `findRequestById` can never abort the scan before an earlier
 * qualifying match is used (the pre-refactor short-circuit behaviour).
 */
async function* selectOwnerQuestions(
  questions: readonly unknown[],
  scope: UnsealedRemovalScope,
  coordinationRequestRepository: CoordinationRequestRepositoryAdapter,
): AsyncGenerator<SelectedOwnerQuestion> {
  for (let index = 0; index < questions.length; index += 1) {
    if (!Object.hasOwn(questions, index)) {
      continue;
    }
    const question = readApprovedOneWayQuestion(questions[index]);
    if (question === null) {
      continue;
    }
    const coordReq = await coordinationRequestRepository.findRequestById(question.linkedRequestId);
    if (
      coordReq === null ||
      coordReq.projectId !== scope.projectId ||
      coordReq.actionScope !== scope.actionScope ||
      coordReq.expectedHeadSha !== scope.expectedHeadSha ||
      coordReq.policyGrant !== undefined
    ) {
      continue;
    }
    yield { question, coordReq };
  }
}

/**
 * Authorize the candidate questions in order, pulling each next candidate
 * only after the previous one failed to authorize: a crash-recovery-shaped
 * request recovers only through the verified consume replay, everything else
 * goes through the fresh resolve-and-consume. Returns the first approved
 * result, or null when no candidate yields one.
 */
async function authorizeSelectedQuestions(
  coordination: UnsealedRemovalAuthorizerDeps['coordination'],
  scope: UnsealedRemovalScope,
  candidates: AsyncGenerator<SelectedOwnerQuestion>,
): Promise<AuthorizeUnsealedWorktreeRemovalResult | null> {
  for await (const candidate of candidates) {
    const authorized = isCrashRecoveryConsumption(candidate.coordReq, scope)
      ? await tryCrashRecovery(coordination, scope, candidate)
      : await freshConsume(coordination, scope, candidate);
    if (authorized !== null) {
      return authorized;
    }
  }
  return null;
}

/**
 * Crash recovery: a grant already consumed by exactly this action id and
 * attempt recovers only through the verified consume replay. KEY0c3: the
 * stored `consumptions[0]` receipt alone is never authority —
 * `recordAuthorizationConsumption` re-verifies the signed answer, so a
 * missing or mismatching signed answer never returns `approved`.
 *
 * Returns the approved result on a verified replay, or null when the replay
 * is refused (the caller never falls back to a fresh authorization for the
 * same question).
 */
async function tryCrashRecovery(
  coordination: UnsealedRemovalAuthorizerDeps['coordination'],
  scope: UnsealedRemovalScope,
  candidate: SelectedOwnerQuestion,
): Promise<AuthorizeUnsealedWorktreeRemovalResult | null> {
  const { question, coordReq } = candidate;
  const consumption = coordReq.consumptions[0];
  if (
    coordReq.consumptions.length !== 1 ||
    consumption === undefined ||
    consumption.actionId !== scope.actionId ||
    consumption.attemptId !== scope.attemptId ||
    coordReq.grantId === null
  ) {
    return null;
  }
  const consumed = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption(
    {
      consumptionId: consumption.consumptionId,
      grantId: coordReq.grantId,
      actionId: scope.actionId,
      actionScope: scope.actionScope,
      attemptId: scope.attemptId,
      expectedHeadSha: scope.expectedHeadSha,
      nowIso: scope.nowIso,
    },
  );
  if (consumed.outcome !== 'consumed') {
    return null;
  }
  return {
    outcome: 'approved',
    approvalReference: `${question.questionId}:${coordReq.id}:${coordReq.grantId}`,
  };
}

/**
 * Fresh authorization: resolve the owner grant for this exact attempt and
 * consume it exactly once. Returns the approved result, or null when the
 * resolve does not match this request (the caller moves on to the next
 * question); a resolve that matches but is refused to consume is blocked.
 */
async function freshConsume(
  coordination: UnsealedRemovalAuthorizerDeps['coordination'],
  scope: UnsealedRemovalScope,
  candidate: SelectedOwnerQuestion,
): Promise<AuthorizeUnsealedWorktreeRemovalResult | null> {
  const { question, coordReq } = candidate;
  const resolved = await coordination.resolveActionAuthorization.resolveActionAuthorization({
    projectId: scope.projectId,
    actionScope: scope.actionScope,
    expectedHeadSha: scope.expectedHeadSha,
    // CO24g: the approval is bound to the one attempt it names; a resolve
    // without the attempt can no longer authorize an unbound owner grant.
    attemptId: scope.attemptId,
  });
  if (resolved.outcome !== 'authorized' || resolved.requestId !== coordReq.id) {
    return null;
  }
  const consumed = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption(
    {
      consumptionId: consumptionId(scope.actionId),
      grantId: resolved.grantId,
      actionId: scope.actionId,
      actionScope: scope.actionScope,
      attemptId: scope.attemptId,
      expectedHeadSha: scope.expectedHeadSha,
      nowIso: scope.nowIso,
    },
  );
  if (consumed.outcome !== 'consumed') {
    return { outcome: 'blocked', reason: 'consumption-refused' };
  }
  return {
    outcome: 'approved',
    approvalReference: `${question.questionId}:${coordReq.id}:${resolved.grantId}`,
  };
}

/** The largest owner-question list one approval scan reads; more is unknown. */
const MAX_OWNER_QUESTIONS_SCAN = 4_096;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return snapshotPlainDataRecordOrNull(value) !== null;
}

/** A descriptor-safe snapshot of a plain object; null for anything else, never a throw. */
function snapshotPlainDataRecordOrNull(value: unknown): Record<string, unknown> | null {
  try {
    return snapshotPlainDataRecord(value);
  } catch {
    return null;
  }
}

/**
 * The validated approval request: every field present, of the right type and
 * within bounds, or null (the caller answers `blocked` without any store call).
 */
function readAuthorizerRequest(
  request: unknown,
): AuthorizeUnsealedWorktreeRemovalRequest | null {
  const snap = snapshotPlainDataRecordOrNull(request);
  if (snap === null) {
    return null;
  }
  const { projectId, runId, attemptId, worktreePath, expectedHeadSha, nowIso } = snap;
  if (
    typeof projectId !== 'string' ||
    typeof runId !== 'string' ||
    typeof attemptId !== 'string' ||
    typeof worktreePath !== 'string' ||
    worktreePath.length > 4096 ||
    typeof expectedHeadSha !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHeadSha) ||
    typeof nowIso !== 'string' ||
    nowIso.length > 64 ||
    !isCalendarDateTime(nowIso)
  ) {
    return null;
  }
  return { projectId, runId, attemptId, worktreePath, expectedHeadSha, nowIso };
}

/**
 * The ids of an answered, one-way, accepted, signed-decision owner question
 * that is linked to a coordination request; null for any other question or a
 * malformed record.
 */
function readApprovedOneWayQuestion(
  value: unknown,
): { readonly questionId: string; readonly linkedRequestId: string } | null {
  const question = snapshotPlainDataRecordOrNull(value);
  if (question === null) {
    return null;
  }
  const answer = snapshotPlainDataRecordOrNull(question['answer']);
  const { questionId, linkedRequestId } = question;
  if (
    question['doorKind'] !== 'one-way' ||
    question['state'] !== 'answered' ||
    typeof questionId !== 'string' ||
    typeof linkedRequestId !== 'string' ||
    answer === null ||
    answer['shape'] !== 'accept' ||
    answer['answeredVia'] !== 'signed-decision'
  ) {
    return null;
  }
  return { questionId, linkedRequestId };
}
