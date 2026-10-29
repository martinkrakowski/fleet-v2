/** The conductor's review and fix-round acts (K5). */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { PrepareFixAttemptRequest, PrepareFixAttemptResult } from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type { PrepareBriefPackageResult } from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  FindReviewReceiptResult,
  ReviewRequestKind,
  ReviewRequestResult,
  ReviewVerdict,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { HandoverFinding, RenderHandoverBriefInput } from '../../../domain/lane-run-handover.js';
import { renderHandoverBrief } from '../../../domain/lane-run-handover.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunReviewFact } from '../../../domain/lane-run-review-facts.js';
import { head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision, LaneRunReviewFact, LaneRunSeatFact } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { historyEntryOf, selectReviewSeat } from '../../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import { readFrozenManifest } from './frozen-manifest.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, intentMintedIdOf, saveOrRefuse } from './step-context.js';

type ReviewKind = 'brief-check' | 'code-review';
type ActDecision = Extract<LaneRunDecision, { kind: 'act' }>;

export interface ReviewFacts {
  readonly reviewSeat: LaneRunSeatFact;
  readonly briefCheck: LaneRunReviewFact;
  readonly codeReview: LaneRunReviewFact;
}

/** The latest non-null attempt's seat plan; null without one or when it does not parse. */
function latestSeatPlanOf(attemptRecords: readonly (AttemptRecord | null)[]): SeatPlan | null {
  const latest = [...attemptRecords].reverse().find((attempt): attempt is AttemptRecord => attempt !== null) ?? null;
  if (latest === null) {
    return null;
  }
  const planResult = SeatPlan.create(latest.seatPlan);
  return planResult.success && planResult.value !== undefined ? planResult.value : null;
}

/** The models that ran or were bound for the run's attempts, in record order. */
function implementerModelsOf(attemptRecords: readonly (AttemptRecord | null)[]): string[] {
  const models: string[] = [];
  for (const attempt of attemptRecords) {
    const model = attempt === null ? null : historyEntryOf(attempt).model;
    if (model !== null) {
      models.push(model);
    }
  }
  return models;
}

/**
 * D10: the seat pinned by a recorded `review-failed` result of `kind` in this
 * run, on any head: the LATEST such result's seat index; null when none.
 */
function pinnedReviewSeatIndex(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  kind: ReviewKind,
): number | null {
  let pinned: number | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.runId !== runId || entry.reasonCode !== 'review-failed' || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed !== null && parsed.kind === 'step' && parsed.step === kind) {
      pinned = parsed.seatIndex;
    }
  }
  return pinned;
}

/**
 * The review seat for `kind` (plan §3.4). D10 first, independent of the
 * family comparison: a recorded fail pins its seat even when
 * `sameModelFamily` is unbound; a pinned index outside the plan reads
 * `{ ok: false }` (the run parks rather than switching seats). Without a pin,
 * `selectReviewSeat` over the run's implementer models; no plan or no
 * comparison → `{ ok: false }`.
 */
function reviewSeatOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  kind: ReviewKind,
  entries: readonly LaneRunJournalEntryRecord[],
  attemptRecords: readonly (AttemptRecord | null)[],
): LaneRunSeatFact {
  const plan = latestSeatPlanOf(attemptRecords);
  if (plan === null) {
    return { ok: false };
  }
  const pinned = pinnedReviewSeatIndex(entries, record.runId, kind);
  if (pinned !== null) {
    return pinned < plan.getSeats('review').length ? { ok: true, seatIndex: pinned } : { ok: false };
  }
  const sameFamily = ctx.deps.sameModelFamily;
  if (sameFamily === undefined) {
    return { ok: false };
  }
  const selected = selectReviewSeat({
    plan,
    round: record.round,
    implementerModels: implementerModelsOf(attemptRecords),
    sameFamily,
  });
  return selected.ok ? { ok: true, seatIndex: selected.seatIndex } : { ok: false };
}

/**
 * The review facts of one advance (K5, plan §3.4): the per-kind journal facts
 * (`briefCheck`, `codeReview`) plus the review seat for the kind due. Pure
 * except `ctx.deps.sameModelFamily`; nothing throws.
 */
export function reviewFactsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  state: LaneRunStateValue,
  entries: readonly LaneRunJournalEntryRecord[],
  head12: string | null,
  attemptRecords: readonly (AttemptRecord | null)[],
): ReviewFacts {
  const briefCheck = laneRunReviewFact(entries, record.runId, 'brief-check', head12);
  const codeReview = laneRunReviewFact(entries, record.runId, 'code-review', head12);
  const reviewSeat: LaneRunSeatFact =
    state === 'brief-check' || state === 'code-review'
      ? reviewSeatOf(ctx, record, state, entries, attemptRecords)
      : { ok: false };
  return { reviewSeat, briefCheck, codeReview };
}

/** `acceptanceChecks` of a frozen manifest: a non-empty array of non-empty strings, else null. */
function manifestAcceptanceChecks(manifest: Record<string, unknown> | null): readonly string[] | null {
  if (manifest === null) {
    return null;
  }
  const value = manifest.acceptanceChecks;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    return null;
  }
  return value as readonly string[];
}

/** Append the step's result under its key and report the act; a journal refusal is the advance's refusal. */
async function finishReview(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ActDecision,
  result: 'completed' | 'refused',
  reasonCode: LaneRunResultReasonCode,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, result, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result, reasonCode };
}

/** Nothing is established: the intent stays pending for the review reconcile (K5-4b); no result entry. */
function pendingReview(decision: ActDecision): AdvanceLaneRunResult {
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'review-unknown' };
}

/** The journal result for a receipt verdict (K5-4a mapping, reused by the review reconcile). */
function reviewResultOfVerdict(verdict: ReviewVerdict): { readonly result: 'completed'; readonly reasonCode: LaneRunResultReasonCode } {
  if (verdict === 'passed') {
    return { result: 'completed', reasonCode: 'review-passed' };
  }
  return { result: 'completed', reasonCode: verdict === 'failed' ? 'review-failed' : 'review-unknown' };
}

/** The journal result for a review port outcome; null when nothing is established. */
function reviewResultOf(
  outcome: ReviewRequestResult,
): { readonly result: 'completed' | 'refused'; readonly reasonCode: LaneRunResultReasonCode } | null {
  switch (outcome.outcome) {
    case 'unknown':
      return null;
    case 'no-receipt':
      return { result: 'completed', reasonCode: 'review-no-receipt' };
    case 'refused':
      return { result: 'refused', reasonCode: 'review-refused' };
    default:
      return reviewResultOfVerdict(outcome.receipt.verdict);
  }
}

interface ReviewInputs {
  readonly latest: AttemptRecord;
  readonly head: string;
  readonly workOrder: WorkOrderRecord;
  readonly reviewerModel: string;
  readonly implementerModel: string;
}

type ReviewInputsRead =
  | { readonly ok: true; readonly inputs: ReviewInputs }
  | { readonly ok: false; readonly result: AdvanceLaneRunResult }
  | { readonly ok: false; readonly refuse: LaneRunResultReasonCode };

/** The act's inputs before any write: wiring, the collected head, the work order, the two models. */
async function reviewInputsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
): Promise<ReviewInputsRead> {
  const workOrderRepo = ctx.deps.workOrderRepo;
  if (ctx.deps.reviewRequest === undefined || ctx.deps.reviewAssessment === undefined || workOrderRepo === undefined) {
    return { ok: false, result: { outcome: 'not-wired', step: decision.step } };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { ok: false, result: { outcome: 'waiting', reason: 'facts-inconsistent' } };
  }
  const workOrder = await workOrderRepo.findWorkOrderById(record.workOrderId);
  if (workOrder === null) {
    return { ok: false, result: { outcome: 'waiting', reason: 'facts-inconsistent' } };
  }
  const planResult = SeatPlan.create(latest.seatPlan);
  const reviewerSeat = planResult.value?.getSeats('review')[decision.seatIndex];
  if (reviewerSeat === undefined) {
    return { ok: false, refuse: 'review-seat-unavailable' };
  }
  const implementerModel = historyEntryOf(latest).model;
  if (implementerModel === null) {
    return { ok: false, refuse: 'review-refused' };
  }
  return {
    ok: true,
    inputs: { latest, head: latest.artifacts.headCommit, workOrder, reviewerModel: reviewerSeat.model, implementerModel },
  };
}

/** The frozen brief text for a brief check (`.lane/brief.md`); undefined for a code review or when unreadable. */
async function briefTextFor(ctx: AdvanceStepContext, latest: AttemptRecord, step: string): Promise<string | undefined> {
  if (step !== 'brief-check') {
    return undefined;
  }
  const read = await ctx.deps.artifactPort.readBriefFile?.(latest.worktreePath, '.lane/brief.md', latest.runner ?? null);
  return read ?? undefined;
}

/**
 * The `act brief-check` and `act code-review` steps (K5, plan §3.3, §3.4):
 * one review through `ReviewRequestPort` under a journalled request id, after
 * opening the evidence assessment through `ReviewAssessmentPort` with the
 * frozen brief's required checks. Order: the intent (minted id = the request
 * id) before any port call, then the assessment, then the request, then one
 * result entry. Only reason codes are journalled, never reply text or
 * findings; an `unknown` outcome or a throw leaves the intent pending
 * (`ambiguous`), which K5-4b reconciles by request id.
 */
export async function performReview(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const read = await reviewInputsOf(ctx, record, gathered, decision);
  if (!read.ok) {
    if ('result' in read) {
      return read.result;
    }
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
    return intentRefusal === null ? finishReview(ctx, request, decision, 'refused', read.refuse) : { outcome: 'refused', reason: intentRefusal };
  }
  const { latest, head, workOrder, reviewerModel, implementerModel } = read.inputs;
  const requestId = 'review-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, requestId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  const requiredChecks = manifestAcceptanceChecks(await readFrozenManifest(latest, ctx.deps.artifactPort));
  if (requiredChecks === null) {
    return finishReview(ctx, request, decision, 'refused', 'assessment-unavailable');
  }
  const opened = await ctx.deps.reviewAssessment!.openReviewAssessment({
    attemptId: latest.id,
    projectId: workOrder.projectId,
    candidateHeadSha: head,
    policyRevision: record.runPolicyRevision,
    implementerModel,
    requiredChecks,
  });
  if (opened.outcome !== 'open') {
    return finishReview(ctx, request, decision, 'refused', 'assessment-unavailable');
  }
  const briefText = await briefTextFor(ctx, latest, decision.step);
  let outcome: ReviewRequestResult;
  try {
    outcome = await ctx.deps.reviewRequest!.requestReview({
      requestId,
      kind: decision.step as ReviewRequestKind,
      attemptId: latest.id,
      projectId: workOrder.projectId,
      candidateHeadSha: head,
      policyRevision: record.runPolicyRevision,
      implementerModel,
      reviewerModel,
      ...(briefText !== undefined ? { briefText } : {}),
      nowIso: request.nowIso,
    });
  } catch {
    return pendingReview(decision);
  }
  const mapped = reviewResultOf(outcome);
  return mapped === null ? pendingReview(decision) : finishReview(ctx, request, decision, mapped.result, mapped.reasonCode);
}

/**
 * The review reconcile (§3.5): an intent without a final result — after a
 * crash, or a review whose `requestReview` left nothing established — is
 * answered from the evidence receipt of the journalled request id, never by
 * a second `requestReview`. A receipt carrying the request id counts; the
 * key closes `review-no-receipt` and the decider issues the one retry key;
 * no minted id or an unavailable receipt stays `ambiguous` for the owner.
 */
export async function reconcileReview(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  if (ctx.deps.reviewRequest === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  // The review key's head must be the latest attempt's collected head; else the facts are inconsistent.
  const parsed = parseLaneRunKey(decision.key);
  if (parsed === null || parsed.kind !== 'step' || parsed.head12 !== head12Of(latest.artifacts.headCommit)) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const requestId = await intentMintedIdOf(ctx, decision.key);
  if (requestId === null) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'ambiguous', 'review-unknown');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'review-unknown' };
  }
  let found: FindReviewReceiptResult;
  try {
    found = await ctx.deps.reviewRequest.findReviewReceipt({
      attemptId: latest.id,
      requestId,
      candidateHeadSha: latest.artifacts.headCommit,
    });
  } catch {
    found = { outcome: 'unavailable', reason: 'unreadable' };
  }
  if (found.outcome === 'found') {
    const mapped = reviewResultOfVerdict(found.receipt.verdict);
    const resultRefusal = await appendRunResult(ctx, request, decision.key, mapped.result, mapped.reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'reconciled', reasonCode: mapped.reasonCode };
  }
  const ambiguous = found.outcome === 'unavailable';
  const reasonCode = ambiguous ? 'review-unknown' : 'review-no-receipt';
  const resultRefusal = await appendRunResult(ctx, request, decision.key, ambiguous ? 'ambiguous' : 'completed', reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: ambiguous ? 'ambiguous' : 'completed', reasonCode };
}

/**
 * Why the run is `fixing`: the LATEST final result entry of this run whose
 * key's step sent it there — a `brief-check`/`code-review` result with reason
 * `review-failed` (a review source), a `gate` result with reason `gate-failed`
 * (a gate source), or a K6 `ci`/`pre-merge` failure (a gate-shaped source with
 * its reason code). `ci` has no key step yet, so only `pre-merge` counts here.
 */
function fixingFailureSourceOf(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): { readonly key: string; readonly source: 'review' | 'gate'; readonly reasonCode: string } | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step') {
      continue;
    }
    if (
      (parsed.step === 'brief-check' || parsed.step === 'code-review') &&
      entry.reasonCode === 'review-failed'
    ) {
      return { key: entry.key, source: 'review', reasonCode: entry.reasonCode };
    }
    if (parsed.step === 'gate' && entry.reasonCode === 'gate-failed') {
      return { key: entry.key, source: 'gate', reasonCode: entry.reasonCode };
    }
    if (parsed.step === 'pre-merge' && entry.reasonCode !== null) {
      return { key: entry.key, source: 'gate', reasonCode: entry.reasonCode };
    }
  }
  return null;
}

/** Receipt findings map one-to-one onto the renderer's typed findings. */
function handoverFindingsOf(receipt: {
  readonly findings: readonly { readonly findingId: string; readonly severity: 'blocker' | 'major' | 'minor' | 'nit';
    readonly summary: string; readonly filePath: string | null; readonly line: number | null }[];
}): HandoverFinding[] {
  return receipt.findings.map((finding) => ({
    findingId: finding.findingId,
    severity: finding.severity,
    summary: finding.summary,
    filePath: finding.filePath,
    line: finding.line,
  }));
}

/**
 * A frozen manifest's required field is present when a string is non-empty,
 * a number is a positive safe integer, or an array or object is non-null.
 */
function isPresentBriefManifestField(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return true;
  }
  return false;
}

/**
 * Rebuild the brief-package request of a fix round from the prior attempt's
 * frozen manifest (KF-6). The manifest of a conducted run carries every
 * required request field except `contextDecisions` and `attemptId` /
 * `worktreePath`, which the fix round supplies; null when the manifest lacks
 * a required field, so the act refuses `prepare-refused`.
 */
function briefRequestFromManifest(input: {
  readonly manifest: Record<string, unknown>;
  readonly fixAttemptId: string;
  readonly worktreePath: string;
  readonly proseMarkdown: string;
}): PrepareBriefPackageUseCaseRequest | null {
  const manifest = input.manifest;
  const requiredFields = [
    'workOrderId', 'projectId', 'taskId', 'laneId', 'repository', 'baseCommit', 'policyRevision',
    'modelAssignment', 'independentReviewer', 'ownedPaths', 'allowedPathPrefixes', 'permissions',
    'acceptanceChecks', 'acceptanceSpec', 'stepLimit', 'timeLimitSeconds', 'resourceBounds',
    'expectedArtifacts', 'ownerDecisionReferences',
  ] as const;
  if (requiredFields.some((field) => !isPresentBriefManifestField(manifest[field]))) {
    return null;
  }
  const modelAssignment = manifest.modelAssignment as PrepareBriefPackageUseCaseRequest['modelAssignment'];
  return {
    workOrderId: manifest.workOrderId as string,
    projectId: manifest.projectId as string,
    taskId: manifest.taskId as string,
    laneId: manifest.laneId as string,
    repository: manifest.repository as string,
    baseCommit: manifest.baseCommit as string,
    policyRevision: manifest.policyRevision as string,
    modelAssignment,
    ...(manifest.seatPlan !== undefined ? { seatPlan: manifest.seatPlan as PrepareBriefPackageUseCaseRequest['seatPlan'] } : {}),
    independentReviewer: manifest.independentReviewer as string,
    ownedPaths: manifest.ownedPaths as string[],
    allowedPathPrefixes: manifest.allowedPathPrefixes as string[],
    permissions: manifest.permissions as string[],
    acceptanceChecks: manifest.acceptanceChecks as string[],
    acceptanceSpec: manifest.acceptanceSpec as PrepareBriefPackageUseCaseRequest['acceptanceSpec'],
    stepLimit: manifest.stepLimit as number,
    timeLimitSeconds: manifest.timeLimitSeconds as number,
    resourceBounds: manifest.resourceBounds as Readonly<Record<string, string>>,
    expectedArtifacts: manifest.expectedArtifacts as string[],
    ownerDecisionReferences: manifest.ownerDecisionReferences as string[],
    ...(manifest.prNotes !== undefined ? { prNotes: manifest.prNotes as PrepareBriefPackageUseCaseRequest['prNotes'] } : {}),
    contextDecisions: [],
    attemptId: input.fixAttemptId,
    worktreePath: input.worktreePath,
    proseMarkdown: input.proseMarkdown,
  };
}

/**
 * The `act prepare` for a fix round (K5-5, plan §3.3 Fix row): render the
 * handover brief from the failure that sent the run to `fixing` — numbered
 * findings from the review receipt, or the gate's reason code — then prepare
 * the fix attempt through `PrepareFixAttemptPort` in EXACTLY `performPrepare`'s
 * order (intent, brief, port call, record save, result). The rendered `text` is never
 * journalled and never stored here beyond the brief package: the fix use case renders the brief it
 * dispatches from `numberedFixes`. `refuse` is `performPrepare`'s local
 * refusal, so a refusal journals its intent (null minted id) and result under
 * the same key with the same shape.
 */
export async function performFixPrepare(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
  refuse: (reasonCode: LaneRunResultReasonCode) => Promise<AdvanceLaneRunResult>,
): Promise<AdvanceLaneRunResult> {
  const fixPort = ctx.deps.prepareFixAttempt;
  const prepareBrief = ctx.deps.prepareBrief;
  if (fixPort === undefined || ctx.deps.reviewRequest === undefined || prepareBrief === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  if (decision.round !== 1 && decision.round !== 2) {
    return refuse('prepare-refused');
  }
  const round: 1 | 2 = decision.round === 1 ? 1 : 2;
  let prior: AttemptRecord | null = null;
  for (let index = gathered.attemptRecords.length - 1; index >= 0; index -= 1) {
    const candidate = gathered.attemptRecords[index];
    if (candidate !== null && candidate.artifacts !== null) {
      prior = candidate;
      break;
    }
  }
  if (prior === null || prior.artifacts === null) {
    return refuse('no-frozen-brief');
  }
  const head = head12Of(prior.artifacts.headCommit);
  if (head === null) {
    return refuse('prepare-refused');
  }
  const entries = await ctx.deps.runJournal.listForRun(record.runId);
  const failure = fixingFailureSourceOf(entries, record.runId);
  if (failure === null) {
    return refuse('prepare-refused');
  }
  let findings: readonly HandoverFinding[] = [];
  if (failure.source === 'review') {
    const requestId = await intentMintedIdOf(ctx, failure.key);
    if (requestId === null) {
      return refuse('prepare-refused');
    }
    let found: FindReviewReceiptResult;
    try {
      found = await ctx.deps.reviewRequest.findReviewReceipt({
        attemptId: prior.id,
        requestId,
        candidateHeadSha: prior.artifacts.headCommit,
      });
    } catch {
      found = { outcome: 'unavailable', reason: 'unreadable' };
    }
    if (found.outcome !== 'found') {
      return refuse('prepare-refused');
    }
    findings = handoverFindingsOf(found.receipt);
  }
  // The run's recorded branch wins (KF-5b); old records without it fall back
  // to the prior worktree path's last segment (the conductor names worktrees
  // after their branch).
  const branchName = record.branchName ?? prior.worktreePath.split('/').pop() ?? '';
  const brief = renderHandoverBrief({
    runId: record.runId,
    round,
    branchName,
    head12: head,
    source: failure.source === 'review' ? 'review' : 'gate',
    findings,
    gateReasonCodes: failure.source === 'review' ? [] : [failure.reasonCode],
  } satisfies RenderHandoverBriefInput);
  if (!brief.ok || brief.numberedFixes.length === 0) {
    return refuse('prepare-refused');
  }
  const numberedFixes: readonly string[] = brief.numberedFixes;
  const briefFixRequest: PrepareFixAttemptRequest = {
    fixAttemptId: 'attempt-' + ctx.deps.newUlid(),
    workOrderId: record.workOrderId,
    priorAttemptId: prior.id,
    numberedFixes,
    nowIso: request.nowIso,
  };
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, briefFixRequest.fixAttemptId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  // KF-6: place the fix round's brief package from the prior attempt's frozen
  // manifest before preparing the fix attempt. The handover text is the prose;
  // it is never journalled and never stored anywhere but the brief package.
  const manifest = await readFrozenManifest(prior, ctx.deps.artifactPort);
  const briefRequest =
    manifest === null
      ? null
      : briefRequestFromManifest({
          manifest,
          fixAttemptId: briefFixRequest.fixAttemptId,
          worktreePath: prior.worktreePath,
          proseMarkdown: brief.text,
        });
  const refusePrepared = async (): Promise<AdvanceLaneRunResult> => {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'prepare-refused');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'prepare-refused' };
  };
  if (briefRequest === null) {
    return refusePrepared();
  }
  let briefResult: PrepareBriefPackageResult;
  try {
    briefResult = await prepareBrief.prepareBriefPackage(briefRequest);
  } catch {
    briefResult = { outcome: 'rejected', reason: 'prepare-refused' };
  }
  if (briefResult.outcome !== 'prepared') {
    return refusePrepared();
  }
  const fixRequest: PrepareFixAttemptRequest = {
    ...briefFixRequest,
    briefDigest: briefResult.prepared.briefDigest,
    briefPackagePath: briefResult.prepared.prosePath,
  };
  let prepared: PrepareFixAttemptResult;
  try {
    // PrepareFixAttempt selects the fix seat itself; the decider's seat index is advisory until the port takes one (follow-up).
    prepared = await fixPort.prepareFixAttempt(fixRequest);
  } catch {
    prepared = { outcome: 'refused', reason: 'prepare-refused' };
  }
  if (prepared.outcome !== 'prepared' || prepared.attempt.id !== fixRequest.fixAttemptId) {
    return refusePrepared();
  }
  const saved = await saveOrRefuse(ctx,
    { ...record, attemptIds: [...record.attemptIds, prepared.attempt.id], revision: record.revision + 1 },
    request,
  );
  if (!saved.ok) {
    // The intent stays pending; the prepare reconcile finds the attempt and
    // appends the id to the run record (K4-7).
    return { outcome: 'refused', reason: saved.reason };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'prepared');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'prepared' };
}
