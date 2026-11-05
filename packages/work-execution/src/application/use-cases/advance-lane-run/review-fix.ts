/** The conductor's review and fix-round acts (K5). */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { PrepareFixAttemptRequest, PrepareFixAttemptResult } from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type { PrepareBriefPackageResult } from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  FindReviewReceiptResult,
  ReviewRequestFinding,
  ReviewRequestKind,
  ReviewRequestResult,
  ReviewVerdict,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { HandoverFinding, RenderHandoverBriefInput } from '../../../domain/lane-run-handover.js';
import { originalBriefOf, renderHandoverBrief } from '../../../domain/lane-run-handover.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunReviewFact } from '../../../domain/lane-run-review-facts.js';
import { buildLaneRunStepKey, head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision, LaneRunReviewFact, LaneRunSeatFact } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { partitionFindingsByScope } from '../../../domain/review-finding-scope.js';
import { historyEntryOf, selectReviewSeat } from '../../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { AcceptanceSpec } from '../../../domain/value-objects/AcceptanceSpec.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import { readFrozenBriefVerified } from './frozen-manifest.js';
import { conductedRunnerOf } from './conducted-host.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, intentMintedIdOf, performPark, refusedResult, saveOrRefuse } from './step-context.js';
import { lastDispatchLeftDirtyWorktree } from './dirty-handover.js';
import { nonPassingGatePredicatesOf } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

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
  detail: string | null = null,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, result, reasonCode, detail);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  // KF-33b2: the acted result carries a non-null journalled detail so the
  // conductor pass can report an `out-of-scope-findings` attention item.
  return {
    outcome: 'acted',
    step: decision.step,
    key: decision.key,
    result,
    reasonCode,
    ...(detail !== null ? { detail } : {}),
  };
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
): { readonly result: 'completed' | 'refused'; readonly reasonCode: LaneRunResultReasonCode; readonly detail: string | null } | null {
  switch (outcome.outcome) {
    case 'unknown':
      return null;
    case 'no-receipt':
      return { result: 'completed', reasonCode: 'review-no-receipt', detail: outcome.detail };
    case 'refused':
      return { result: 'refused', reasonCode: 'review-refused', detail: outcome.detail };
    default:
      return { ...reviewResultOfVerdict(outcome.receipt.verdict), detail: null };
  }
}

/**
 * KF-33a: the lane's changed-path set between the run's original base (the
 * FIRST non-null attempt record's baseCommit; a fix attempt's own base is not
 * the lane base) and `prior`'s collected head, read through the prior's
 * recorded host. One helper shared by the review step and the fix prepare;
 * they never duplicate the read. An absent method, a null host, a throw or a
 * null answer fail closed: the set is null (unknown), which keeps every
 * finding in scope, exactly as before the rule existed.
 */
async function changedPathsOf(
  ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  prior: AttemptRecord,
  headCommit: string,
): Promise<readonly string[] | null> {
  const laneBase = gathered.attemptRecords.find((entry) => entry !== null)?.baseCommit ?? null;
  const priorHost = conductedRunnerOf(prior);
  if (laneBase === null || priorHost === null) {
    return null;
  }
  try {
    return (
      (await ctx.deps.artifactPort.readChangedPaths?.(prior.worktreePath, laneBase, headCommit, priorHost)) ?? null
    );
  } catch {
    return null;
  }
}

/** One out-of-scope recording through the port; false on any refusal or throw. */
async function recordOutOfScopeFindings(
  ctx: AdvanceStepContext,
  attemptId: string,
  candidateHeadSha: string,
  findingIds: readonly string[],
): Promise<boolean> {
  const port = ctx.deps.reviewRequest;
  if (port?.recordOutOfScope === undefined) {
    return false;
  }
  try {
    return (await port.recordOutOfScope({ attemptId, candidateHeadSha, findingIds })).outcome === 'recorded';
  } catch {
    return false;
  }
}

const MINOR_ONLY_SEVERITIES: readonly string[] = ['minor', 'nit'];

/**
 * GB1: a minors-only failed brief-check receipt does not block the run. True
 * exactly when the kind is `brief-check`, the receipt verdict is `failed`, the
 * receipt has at least one finding, and every finding's severity is `minor`
 * or `nit`. Any blocker or major finding, zero findings, or another kind keeps
 * the plain `review-failed` mapping (fail closed).
 */
function isMinorOnlyBriefCheckReceipt(
  kind: ReviewKind,
  receipt: { readonly verdict: ReviewVerdict; readonly findings: readonly ReviewRequestFinding[] },
): boolean {
  if (kind !== 'brief-check' || receipt.verdict !== 'failed' || receipt.findings.length === 0) {
    return false;
  }
  return receipt.findings.every((finding) => MINOR_ONLY_SEVERITIES.includes(finding.severity));
}

/** The minor-only override: the same shape the plain mapping carries, with the fixed detail token. */
const MINOR_ONLY_OVERRIDE = {
  result: 'completed',
  reasonCode: 'review-passed',
  detail: 'minor-only-findings',
} as const;

/**
 * GB1: when the resolved mapping is still `review-failed` for a receipt, the
 * minors-only brief-check override applies on top of it. The scope disposition
 * runs first: an `out-of-scope-findings` result is never touched, and neither
 * is any non-`review-failed` mapping.
 */
function minorOnlyOverrideOf(
  step: ReviewKind,
  outcome: ReviewRequestResult,
  resolved: { readonly result: 'completed' | 'refused'; readonly reasonCode: LaneRunResultReasonCode; readonly detail: string | null },
): typeof resolved {
  if (resolved.reasonCode !== 'review-failed' || outcome.outcome !== 'receipt') {
    return resolved;
  }
  if (!isMinorOnlyBriefCheckReceipt(step, outcome.receipt)) {
    return resolved;
  }
  return { ...MINOR_ONLY_OVERRIDE };
}

/**
 * GB1: the reconcile's answer mapping with the minors-only brief-check
 * override applied. The detail stays null unless the override applies, so the
 * fixed token only ever marks a minors-only override receipt.
 */
function reconciledReviewOf(
  step: ReviewKind,
  receipt: { readonly verdict: ReviewVerdict; readonly findings: readonly ReviewRequestFinding[] },
  mapped: { readonly result: 'completed'; readonly reasonCode: LaneRunResultReasonCode },
): { readonly result: 'completed'; readonly reasonCode: LaneRunResultReasonCode; readonly detail: string | null } {
  if (mapped.reasonCode === 'review-failed' && step === 'brief-check' && isMinorOnlyBriefCheckReceipt(step, receipt)) {
    return { ...MINOR_ONLY_OVERRIDE };
  }
  return { ...mapped, detail: null };
}

/**
 * KF-33b2: a failed receipt with findings is checked against the lane's
 * changed set before it fails the run. An unknown changed set or no
 * out-of-scope finding leaves the mapping unchanged. With out-of-scope
 * findings the dispositions are recorded through the port: a mixed review
 * keeps `review-failed` (some findings are this lane's); when every finding
 * is out of scope, only an answering `recorded` journals `review-passed`
 * with the fixed detail `out-of-scope-findings` — a `refused` recording
 * keeps `review-failed` (fail closed). The detail is a fixed token; reviewer
 * text is never copied into the journal.
 */
async function reviewScopeDispositionOf(
  ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  latest: AttemptRecord,
  head: string,
  findings: readonly ReviewRequestFinding[],
  mapped: { readonly result: 'completed' | 'refused'; readonly reasonCode: LaneRunResultReasonCode; readonly detail: string | null },
): Promise<typeof mapped> {
  const changed = await changedPathsOf(ctx, gathered, latest, head);
  const partition = partitionFindingsByScope(
    findings.map((finding) => ({ findingId: finding.findingId, filePath: finding.filePath })),
    changed,
    latest.worktreePath,
  );
  if (changed === null || partition.outOfScope.length === 0) {
    return mapped;
  }
  const recorded = await recordOutOfScopeFindings(
    ctx,
    latest.id,
    head,
    partition.outOfScope.map((finding) => finding.findingId),
  );
  if (partition.outOfScope.length < findings.length) {
    return mapped;
  }
  return recorded
    ? { result: 'completed', reasonCode: 'review-passed', detail: 'out-of-scope-findings' }
    : mapped;
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
    return intentRefusal === null ? finishReview(ctx, request, decision, 'refused', read.refuse) : refusedResult(intentRefusal);
  }
  const { latest, head, workOrder, reviewerModel, implementerModel } = read.inputs;
  if (request.startGate !== undefined) {
    // The wait sits before the one-way intent, so a crash during the wait spends no key.
    if (!request.startGate.tryStart(request.runId, request.nowIso).ok) {
      return { outcome: 'waiting', reason: 'session-stagger' };
    }
  }
  const requestId = 'review-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, requestId);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  // The frozen brief is read ONCE, digest-verified here (SEC-3b): the
  // required checks come from its manifest and a brief check's reviewer text
  // is exactly the prose the digest covered. A read that does not verify
  // against the attempt's recorded digest refuses before the assessment is
  // opened and before any reviewer runs; an absent read (nothing recorded to
  // read) keeps today's unavailable refusal.
  const frozen = await readFrozenBriefVerified(latest, ctx.deps.artifactPort, ctx.deps.computeDigest);
  if (frozen.kind === 'unverified') {
    return finishReview(ctx, request, decision, 'refused', 'assessment-unavailable');
  }
  const requiredChecks = manifestAcceptanceChecks(frozen.kind === 'verified' ? frozen.manifest : null);
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
  const briefText = decision.step === 'brief-check' && frozen.kind === 'verified' ? frozen.prose : undefined;
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
  if (mapped === null) {
    return pendingReview(decision);
  }
  // KF-33b2: a failed receipt with findings is scoped before it fails the
  // run; everything else keeps its plain mapping.
  const resolved =
    outcome.outcome === 'receipt' && outcome.receipt.verdict === 'failed' && outcome.receipt.findings.length > 0
      ? await reviewScopeDispositionOf(ctx, gathered, latest, head, outcome.receipt.findings, mapped)
      : mapped;
  // GB1: after the scope disposition, a still-failed minors-only brief-check
  // receipt journals `review-passed` with the fixed detail instead.
  const override = minorOnlyOverrideOf(decision.step as ReviewKind, outcome, resolved);
  return finishReview(ctx, request, decision, override.result, override.reasonCode, override.detail);
}

/**
 * KS6: the brief-check review starts beside the gate. The gate body calls
 * this right after its own evaluation is launched, so the review is requested
 * on the sealed diff (the collected head) while the gate runs, and the
 * brief-check state later reads the recorded receipt instead of requesting a
 * second review. Failure-tolerant by design — an unwired port, missing facts,
 * an existing brief-check intent, an unavailable seat or a built-key failure
 * starts nothing, and a throw from the journal read or `performReview` is
 * swallowed — because a
 * review that cannot start must never block or change the gate's own result:
 * the brief-check state keeps behaving exactly as it does without the
 * in-flight start. The session-start gate inside `performReview` still sits
 * before its one-way intent, so a staggered refusal writes nothing here.
 */
export async function startBriefCheckInFlight(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  request: AdvanceLaneRunRequest,
): Promise<void> {
  if (
    ctx.deps.reviewRequest === undefined ||
    ctx.deps.reviewAssessment === undefined ||
    ctx.deps.workOrderRepo === undefined
  ) {
    return;
  }
  const head12 = gathered.facts.head12;
  if (gathered.latestAttempt === null || gathered.latestAttempt.artifacts === null || head12 === null) {
    return;
  }
  if (gathered.facts.briefCheck.verdict !== 'none') {
    return;
  }
  try {
    const entries = await ctx.deps.runJournal.listForRun(record.runId);
    const seat = reviewSeatOf(ctx, record, 'brief-check', entries, gathered.attemptRecords);
    if (!seat.ok) {
      return;
    }
    const key = buildLaneRunStepKey({
      runId: record.runId,
      round: record.round,
      step: 'brief-check',
      seatIndex: seat.seatIndex,
      attemptOrdinal: null,
      head12,
      retry: null,
    });
    if (!key.ok) {
      return;
    }
    const decision: ActDecision = {
      kind: 'act',
      step: 'brief-check',
      key: key.key,
      round: record.round,
      seatIndex: seat.seatIndex,
      head12,
      retry: null,
    };
    await performReview(ctx, record, gathered, decision, request);
  } catch {
    // A review that cannot start — a journal read, a seat, a key or the
    // request itself — never blocks the gate.
  }
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
      return refusedResult(resultRefusal);
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
    // GB1: a minors-only failed brief-check receipt reconciles review-passed
    // with the fixed detail, before the result entry is appended.
    const resolved = reconciledReviewOf(parsed.step as ReviewKind, found.receipt, mapped);
    const resultRefusal = await appendRunResult(ctx, request, decision.key, resolved.result, resolved.reasonCode, resolved.detail);
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'reconciled', reasonCode: resolved.reasonCode };
  }
  const ambiguous = found.outcome === 'unavailable';
  const reasonCode = ambiguous ? 'review-unknown' : 'review-no-receipt';
  const resultRefusal = await appendRunResult(ctx, request, decision.key, ambiguous ? 'ambiguous' : 'completed', reasonCode);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: ambiguous ? 'ambiguous' : 'completed', reasonCode };
}

/**
 * AR1/MX7: every final `brief-check`/`code-review` result key of this run at
 * `head12`, latest first (journal order) — any final reason code, so both a
 * `review-failed` result and a GB1 `review-passed` with the
 * `minor-only-findings` detail are candidates. Which candidate actually
 * carries the unresolved findings is decided by its receipt, not by the
 * journal result alone.
 */
function reviewResultKeysAtHead(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  head12: string,
): { readonly key: string; readonly step: ReviewKind }[] {
  const candidates: { key: string; step: ReviewKind }[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.head12 !== head12) {
      continue;
    }
    if (parsed.step !== 'brief-check' && parsed.step !== 'code-review') {
      continue;
    }
    candidates.push({ key: entry.key, step: parsed.step });
  }
  return candidates;
}

type FixingSource = {
  readonly key: string | null;
  readonly acceptHead12: string | null;
  readonly source: 'review' | 'gate';
  readonly reasonCode: string;
};

type FixingSourceOfEntryVerdict =
  | { readonly kind: 'skip' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'source'; readonly source: FixingSource };

/**
 * One journal entry's contribution to the fix source: a source object when
 * this entry sent the run fixing, `skip` when it is not a candidate, and
 * `stop` when the walk must end with no source (an accept rejection whose key
 * carries no head).
 */
function fixingSourceOfEntry(
  entry: LaneRunJournalEntryRecord,
  parsed: ReturnType<typeof parseLaneRunKey>,
  runId: string,
): FixingSourceOfEntryVerdict {
  if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
    return { kind: 'skip' };
  }
  if (parsed === null || parsed.kind !== 'step') {
    return { kind: 'skip' };
  }
  if (
    (parsed.step === 'brief-check' || parsed.step === 'code-review') &&
    entry.reasonCode === 'review-failed'
  ) {
    return { kind: 'source', source: { key: entry.key, acceptHead12: null, source: 'review', reasonCode: entry.reasonCode } };
  }
  if (parsed.step === 'gate' && entry.reasonCode === 'gate-failed') {
    return { kind: 'source', source: { key: entry.key, acceptHead12: null, source: 'gate', reasonCode: entry.reasonCode } };
  }
  if (parsed.step === 'ci' && entry.reasonCode === 'ci-failed') {
    // GB4: a CI failure is a gate-shaped source with its bare reason code;
    // the gate-predicate refusal (gate-failed only) never fires for it.
    return { kind: 'source', source: { key: entry.key, acceptHead12: null, source: 'gate', reasonCode: entry.reasonCode } };
  }
  if (parsed.step === 'pre-merge' && entry.reasonCode !== null) {
    return { kind: 'source', source: { key: entry.key, acceptHead12: null, source: 'gate', reasonCode: entry.reasonCode } };
  }
  if (
    parsed.step === 'accept' &&
    entry.reasonCode === 'acceptance-rejected' &&
    (entry.detail === 'review-findings' || entry.detail === null)
  ) {
    // AR1/MX7: the review source of an accept rejection is receipt-driven.
    // No key is picked from the journal result alone: `performFixPrepare`
    // lists the review results at this head and walks their receipts.
    if (parsed.head12 === null) {
      return { kind: 'stop' };
    }
    return { kind: 'source', source: { key: null, acceptHead12: parsed.head12, source: 'review', reasonCode: 'review-failed' } };
  }
  return { kind: 'skip' };
}

/**
 * Why the run is `fixing`: the LATEST final result entry of this run whose
 * key's step sent it there — a `brief-check`/`code-review` result with reason
 * `review-failed` (a review source), a `gate` result with reason `gate-failed`
 * (a gate source), a K6 `pre-merge` failure or the GB4 keyed `ci` failure (a
 * gate-shaped source with its reason code).
 * AR1/F61 add the review-blocked acceptance rejection: an `accept` result with
 * reason `acceptance-rejected` and detail `review-findings` (AR1), or a null
 * detail (F61, a pre-AR1 rejection classified from the assessment), hands the
 * review results at that head to the fix round; `performFixPrepare` then picks
 * the candidate whose receipt carries unresolved findings (MX7).
 */
function fixingFailureSourceOf(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): FixingSource | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const parsed = parseLaneRunKey(entry.key);
    const verdict = fixingSourceOfEntry(entry, parsed, runId);
    if (verdict.kind === 'skip') {
      continue;
    }
    if (verdict.kind === 'stop') {
      return null;
    }
    return verdict.source;
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
 * Filter findings by finding state and lane changed-path scope. Drops any
 * finding whose state is `out-of-scope`, and delegates the rest to the
 * domain scope partition.
 */
function inScopeFindingsOf<T extends ReviewRequestFinding>(
  findings: readonly T[],
  changedPaths: readonly string[] | null,
  worktreePath: string | null = null,
): readonly T[] {
  const active = findings.filter((finding) => finding.state !== 'out-of-scope');
  return partitionFindingsByScope(active, changedPaths, worktreePath).inScope;
}

/**
 * AR1/MX7: the receipt behind one candidate review result — by the intent's
 * minted request id first, and when that yields nothing, by kind at the
 * prior's collected head. Null without a receipt; the walk continues.
 */
async function candidateReceiptOf(
  ctx: AdvanceStepContext,
  prior: AttemptRecord,
  candidate: { readonly key: string; readonly step: ReviewKind },
): Promise<{ readonly findings: readonly ReviewRequestFinding[]; readonly verdict: string } | null> {
  const reviewRequest = ctx.deps.reviewRequest;
  if (reviewRequest === undefined || prior.artifacts === null) {
    return null;
  }
  const requestId = await intentMintedIdOf(ctx, candidate.key);
  if (requestId !== null) {
    try {
      const found = await reviewRequest.findReviewReceipt({
        attemptId: prior.id,
        requestId,
        candidateHeadSha: prior.artifacts.headCommit,
      });
      if (found.outcome === 'found') {
        return found.receipt;
      }
    } catch {
      // Fall through to the kind lookup at the head.
    }
  }
  try {
    const latest = await reviewRequest.findLatestReceiptOfKind({
      attemptId: prior.id,
      candidateHeadSha: prior.artifacts.headCommit,
      kind: candidate.step,
    });
    if (latest.outcome === 'found') {
      return latest.receipt;
    }
  } catch {
    // Skip this candidate; the walk continues.
  }
  return null;
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
  /** The prior attempt's runner block, so the placement runs on the reserved host (KF-9). */
  readonly recordedHost: AttemptRunnerRecord | null;
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
    recordedHost: input.recordedHost,
  };
}

/** The refusal builder `performPrepare` hands to the fix prepare, as-is. */
type FixPrepareRefuse = (
  reasonCode: LaneRunResultReasonCode,
  detail?: string | null,
) => Promise<AdvanceLaneRunResult>;

/** The request pieces every fix-prepare step reads. */
interface FixPrepareShared {
  readonly ctx: AdvanceStepContext;
  readonly record: LaneRunRecord;
  readonly gathered: GatheredLaneRunFacts;
  readonly decision: ActDecision;
  readonly request: AdvanceLaneRunRequest;
  readonly refuse: FixPrepareRefuse;
}

/** The prepare ports the wiring step proved present. */
interface FixPreparePorts {
  readonly fixPort: NonNullable<AdvanceStepContext['deps']['prepareFixAttempt']>;
  readonly prepareBrief: NonNullable<AdvanceStepContext['deps']['prepareBrief']>;
  readonly reviewRequest: NonNullable<AdvanceStepContext['deps']['reviewRequest']>;
}

/** The shared request pieces plus the wiring the first step established. */
type FixPrepareWired = FixPrepareShared & { readonly ports: FixPreparePorts };

/**
 * One fix-prepare step's outcome: `refused` carries the early return the
 * step produced, `ok` carries the step's values forward (`value` absent when
 * the step only guards). This is the one convention every step helper uses.
 */
type FixPrepareStepOutcome<T> =
  | { readonly status: 'refused'; readonly result: AdvanceLaneRunResult }
  | { readonly status: 'ok'; readonly value: T };

/** The prior as the fix-prepare steps read it: its artifacts are proven present. */
type ArtifactBearingAttempt = AttemptRecord & { readonly artifacts: NonNullable<AttemptRecord['artifacts']> };

/** The values the early steps establish before any brief material is read. */
interface FixPrepareContext {
  readonly round: 1 | 2;
  readonly prior: ArtifactBearingAttempt;
  readonly head: string;
  readonly entries: readonly LaneRunJournalEntryRecord[];
  readonly failure: FixingSource;
}

/** The prior's digest-verified brief read. */
interface FixReadBrief {
  readonly prose: string;
  readonly manifestRaw: string;
  readonly recordedHost: AttemptRunnerRecord;
}

/** The verified manifest and the cancelled handover it may be (KF-28). */
interface FixVerifiedManifest {
  readonly manifest: Record<string, unknown>;
  readonly trustedHandover: AttemptRecord | null;
}

/** One failed gate check: name, verdict and exit code only — never a detail. */
interface FixGatePredicate {
  readonly name: string;
  readonly verdict: 'fail' | 'unknown';
  readonly exitCode: number | null;
}

/** Step 1: the prepare ports must all be wired before anything runs. */
function fixPrepareWiringStep(shared: FixPrepareShared): FixPrepareStepOutcome<FixPreparePorts> {
  const deps = shared.ctx.deps;
  if (deps.prepareFixAttempt === undefined || deps.reviewRequest === undefined || deps.prepareBrief === undefined) {
    return { status: 'refused', result: { outcome: 'not-wired', step: shared.decision.step } };
  }
  return {
    status: 'ok',
    value: { fixPort: deps.prepareFixAttempt, prepareBrief: deps.prepareBrief, reviewRequest: deps.reviewRequest },
  };
}

/**
 * Step 2: a spent key parks the run for the owner before anything is
 * written (KF-9).
 */
async function fixPrepareSpentKeyStep(shared: FixPrepareWired): Promise<FixPrepareStepOutcome<void>> {
  const keyEntries = await shared.ctx.deps.runJournal.listForKey(shared.decision.key);
  if (keyEntries.some((entry) => entry.kind === 'intent')) {
    return {
      status: 'refused',
      result: await performPark(
        shared.ctx,
        shared.record,
        'step-refused',
        'prepare',
        shared.gathered.facts.state,
        shared.request,
      ),
    };
  }
  return { status: 'ok', value: undefined };
}

/**
 * Steps 3–6: the fix round (1 or 2), the prior attempt WITH artifacts
 * (KF-17), its collected head and the failure that sent the run fixing.
 */
async function fixPreparePriorSourceStep(shared: FixPrepareWired): Promise<FixPrepareStepOutcome<FixPrepareContext>> {
  if (shared.decision.round !== 1 && shared.decision.round !== 2) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-round-out-of-range') };
  }
  const round: 1 | 2 = shared.decision.round === 1 ? 1 : 2;
  // The prior is the latest attempt WITH artifacts: a cancelled fix attempt
  // (never dispatched) is skipped, so after a refused fix dispatch the
  // recovered round prepares from the collected prior in the same round
  // (KF-17).
  let prior: AttemptRecord | null = null;
  for (let index = shared.gathered.attemptRecords.length - 1; index >= 0; index -= 1) {
    const candidate = shared.gathered.attemptRecords[index];
    if (candidate !== null && candidate.artifacts !== null) {
      prior = candidate;
      break;
    }
  }
  if (prior === null || prior.artifacts === null) {
    return { status: 'refused', result: await shared.refuse('no-frozen-brief') };
  }
  // The checks above proved the artifacts present; the cast carries that
  // proof into the step values.
  const established = prior as ArtifactBearingAttempt;
  const head = head12Of(established.artifacts.headCommit);
  if (head === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-head') };
  }
  const entries = await shared.ctx.deps.runJournal.listForRun(shared.record.runId);
  const failure = fixingFailureSourceOf(entries, shared.record.runId);
  if (failure === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-failure-source') };
  }
  return { status: 'ok', value: { round, prior: established, head, entries, failure } };
}

/**
 * Step 7: the review findings that drive the fix round, scope-checked.
 * `changedPathsOf` is awaited before the branch — for every review source,
 * in every branch (KF-33a/KF-33b2).
 */
async function fixPrepareReviewFindingsStep(
  shared: FixPrepareWired,
  context: FixPrepareContext,
): Promise<FixPrepareStepOutcome<readonly HandoverFinding[]>> {
  if (context.failure.source !== 'review') {
    return { status: 'ok', value: [] };
  }
  const changed = await changedPathsOf(shared.ctx, shared.gathered, context.prior, context.prior.artifacts.headCommit);
  if (context.failure.acceptHead12 !== null) {
    return acceptHeadReviewFindings(shared, context.prior, context.entries, context.failure.acceptHead12, changed);
  }
  if (context.failure.key !== null) {
    return keyedReviewFindings(shared, context.prior, context.failure.key, changed);
  }
  return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-failure-source') };
}

/**
 * AR1/MX7: the rejection's review source is receipt-driven. Walk the run's
 * final review results at the rejected head, latest first, and take the
 * newest candidate whose receipt is found and has at least one finding
 * (including a GB1 review-passed with minor-only-findings). If that
 * receipt's findings are all out of scope, refuse no-in-scope-findings and
 * do not continue to older candidates.
 */
async function acceptHeadReviewFindings(
  shared: FixPrepareWired,
  prior: AttemptRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  acceptHead12: string,
  changed: readonly string[] | null,
): Promise<FixPrepareStepOutcome<readonly HandoverFinding[]>> {
  // Receipt summaries carry no finding disposition, so without the lane's
  // changed paths an out-of-scope finding would look in scope and could be
  // handed over: this walk fails closed instead (unlike the keyed path).
  if (changed === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-scope-unavailable') };
  }
  let inScope: readonly ReviewRequestFinding[] | null = null;
  for (const candidate of reviewResultKeysAtHead(entries, shared.record.runId, acceptHead12)) {
    const found = await candidateReceiptOf(shared.ctx, prior, candidate);
    if (found === null || found.findings.length === 0) {
      continue;
    }
    const candidateInScope = inScopeFindingsOf(found.findings, changed, prior.worktreePath);
    if (candidateInScope.length > 0) {
      inScope = candidateInScope;
      break;
    }
    // The newest FAILED receipt decides: with no in-scope finding, refuse
    // rather than reach back to an older one. A passed receipt (GB1
    // minor-only findings) is used only when it has an in-scope finding,
    // else skipped.
    if (found.verdict === 'failed') {
      return { status: 'refused', result: await shared.refuse('no-in-scope-findings') };
    }
  }
  if (inScope === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-review-findings') };
  }
  return { status: 'ok', value: handoverFindingsOf({ findings: inScope }) };
}

/** The keyed review source: the receipt behind the failure's minted request id. */
async function keyedReviewFindings(
  shared: FixPrepareWired,
  prior: ArtifactBearingAttempt,
  failureKey: string,
  changed: readonly string[] | null,
): Promise<FixPrepareStepOutcome<readonly HandoverFinding[]>> {
  const requestId = await intentMintedIdOf(shared.ctx, failureKey);
  if (requestId === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-review-request') };
  }
  let found: FindReviewReceiptResult;
  try {
    found = await shared.ports.reviewRequest.findReviewReceipt({
      attemptId: prior.id,
      requestId,
      candidateHeadSha: prior.artifacts.headCommit,
    });
  } catch {
    found = { outcome: 'unavailable', reason: 'unreadable' };
  }
  if (found.outcome !== 'found') {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-review-receipt-unavailable') };
  }
  const inScope = inScopeFindingsOf(found.receipt.findings, changed, prior.worktreePath);
  if (found.receipt.findings.length > 0 && inScope.length === 0) {
    return { status: 'refused', result: await shared.refuse('no-in-scope-findings') };
  }
  return { status: 'ok', value: handoverFindingsOf({ findings: inScope }) };
}

/**
 * Steps 9–10: the prior's frozen brief package must exist and name a
 * recorded host, then its prose and manifest are read ONCE through that
 * host (KF-21b). Any missing, unreadable or throwing read refuses.
 */
async function fixReadPriorBriefStep(
  shared: FixPrepareWired,
  prior: AttemptRecord,
): Promise<FixPrepareStepOutcome<FixReadBrief>> {
  if (prior.briefPackagePath === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-brief-package') };
  }
  const recordedHost = conductedRunnerOf(prior);
  if (recordedHost === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-recorded-host') };
  }
  let prose: string | null | undefined;
  let manifestRaw: string | null | undefined;
  try {
    prose = await shared.ctx.deps.artifactPort.readBriefFile?.(prior.worktreePath, '.lane/brief.md', recordedHost);
    manifestRaw = await shared.ctx.deps.artifactPort.readBriefManifest?.(
      prior.worktreePath,
      prior.briefPackagePath.replace(/\.md$/, '-manifest.json'),
      recordedHost,
    );
  } catch {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-brief-read-failed') };
  }
  if (typeof prose !== 'string' || typeof manifestRaw !== 'string') {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-brief-unreadable') };
  }
  return { status: 'ok', value: { prose, manifestRaw, recordedHost } };
}

/**
 * A cancelled fix attempt whose `priorAttemptId` names the prior and whose
 * `briefDigest` matches the on-disk digest: the handover that attempt
 * placed over the prior's brief (KF-28). Null when there is none.
 */
function cancelledHandoverOf(
  attemptRecords: readonly (AttemptRecord | null)[],
  priorId: string,
  onDiskDigest: string,
): AttemptRecord | null {
  for (let index = attemptRecords.length - 1; index >= 0; index -= 1) {
    const candidate = attemptRecords[index];
    if (
      candidate !== null &&
      candidate.kind === 'fix' &&
      candidate.state === 'cancelled' &&
      candidate.priorAttemptId === priorId &&
      onDiskDigest === candidate.briefDigest
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Step 11: digest trust (KF-28) and step 12: the manifest parse. The
 * on-disk digest is trusted when it equals the prior's recorded digest, or
 * the `briefDigest` of a cancelled fix attempt in this run whose
 * `priorAttemptId` names the prior. Anything else is untrusted lane text
 * and refuses; the manifest must parse to an object.
 */
async function fixVerifyManifestStep(
  shared: FixPrepareWired,
  gathered: GatheredLaneRunFacts,
  prior: AttemptRecord,
  prose: string,
  manifestRaw: string,
): Promise<FixPrepareStepOutcome<FixVerifiedManifest>> {
  const compute = shared.ctx.deps.computeDigest ?? simpleDeterministicHexDigest;
  let trustedHandover: AttemptRecord | null = null;
  const onDiskDigest = compute(prose + '\n' + manifestRaw);
  if (onDiskDigest !== prior.briefDigest) {
    trustedHandover = cancelledHandoverOf(gathered.attemptRecords, prior.id, onDiskDigest);
    if (trustedHandover === null) {
      return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-brief-digest-mismatch') };
    }
  }
  try {
    const parsed: unknown = JSON.parse(manifestRaw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-manifest-unreadable') };
    }
    return { status: 'ok', value: { manifest: parsed as Record<string, unknown>, trustedHandover } };
  } catch {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-manifest-unreadable') };
  }
}

/**
 * Step 13: the prior's failed gate checks, in their recorded order, verdict
 * and exit code only — never their `detail`. A `gate-failed` with no usable
 * failed check refuses rather than handing the lane a bare reason code.
 */
async function fixPrepareGatePredicatesStep(
  shared: FixPrepareWired,
  prior: ArtifactBearingAttempt,
  failure: FixingSource,
): Promise<FixPrepareStepOutcome<readonly FixGatePredicate[]>> {
  if (failure.source !== 'gate') {
    return { status: 'ok', value: [] };
  }
  let journalEntries: Parameters<typeof nonPassingGatePredicatesOf>[0];
  try {
    journalEntries = await shared.ctx.deps.executionJournal.listJournalEntriesForAttempt(prior.id);
  } catch {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-gate-journal-unreadable') };
  }
  const gatePredicates = nonPassingGatePredicatesOf(journalEntries, prior.id, prior.artifacts.headCommit).map(
    ({ name, verdict, exitCode }) => ({ name, verdict, exitCode }) satisfies FixGatePredicate,
  );
  if (failure.reasonCode === 'gate-failed' && gatePredicates.length === 0) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-gate-checks') };
  }
  return { status: 'ok', value: gatePredicates };
}

/**
 * KS6: a gate failure's fix brief also carries the in-scope findings of the
 * review receipts already recorded at the failed head (the brief-check that
 * ran beside the gate). The changed set is read once, the run's final review
 * results at the head are walked latest first, and the walk stops at the
 * first candidate whose receipt carries at least one in-scope finding. No new
 * refusals: a missing or unreadable receipt, a receipt with no findings or a
 * receipt whose findings are all out of scope simply adds nothing — the
 * gate's own deltas still make the brief.
 */
async function fixPrepareGateReviewFindingsStep(
  shared: FixPrepareWired,
  context: FixPrepareContext,
): Promise<FixPrepareStepOutcome<readonly HandoverFinding[]>> {
  if (context.failure.source !== 'gate') {
    return { status: 'ok', value: [] };
  }
  const changed = await changedPathsOf(shared.ctx, shared.gathered, context.prior, context.prior.artifacts.headCommit);
  for (const candidate of reviewResultKeysAtHead(context.entries, shared.record.runId, context.head)) {
    const found = await candidateReceiptOf(shared.ctx, context.prior, candidate);
    if (found === null) {
      continue;
    }
    const inScope = inScopeFindingsOf(found.findings, changed, context.prior.worktreePath);
    if (inScope.length > 0) {
      return { status: 'ok', value: handoverFindingsOf({ findings: inScope }) };
    }
  }
  return { status: 'ok', value: [] };
}

/**
 * Step 14: the frozen acceptance spec's argv, trusted only through the
 * value object; an invalid spec refuses the prepare.
 */
async function fixPrepareProofCommandsStep(
  shared: FixPrepareWired,
  manifest: Record<string, unknown>,
): Promise<FixPrepareStepOutcome<readonly (readonly string[])[]>> {
  const spec = AcceptanceSpec.create(manifest.acceptanceSpec);
  if (!spec.success || spec.value === undefined) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-acceptance-spec-invalid') };
  }
  return { status: 'ok', value: spec.value.getCommands().map((command) => command.argv) };
}

/**
 * Step 15: the original brief the handover renders. Round 1 carries the
 * prose verbatim; round 2 extracts the previous handover's original
 * section. KF-28: when the verified prose is a cancelled fix attempt's
 * handover, it is a handover too — the original brief is extracted from it
 * even though the prior itself is not a fix attempt.
 */
async function fixPrepareOriginalBriefStep(
  shared: FixPrepareWired,
  prior: AttemptRecord,
  prose: string,
  trustedHandover: AttemptRecord | null,
): Promise<FixPrepareStepOutcome<string>> {
  const originalBrief = trustedHandover === null && prior.kind !== 'fix' ? prose : originalBriefOf(prose);
  if (originalBrief === null) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-no-original-brief') };
  }
  return { status: 'ok', value: originalBrief };
}

/** The inputs of the handover render step. */
interface FixRenderInput {
  readonly prior: AttemptRecord;
  readonly entries: readonly LaneRunJournalEntryRecord[];
  readonly round: 1 | 2;
  readonly head: string;
  readonly failure: FixingSource;
  readonly findings: readonly HandoverFinding[];
  readonly gatePredicates: readonly FixGatePredicate[];
  readonly proofCommands: readonly (readonly string[])[];
  readonly originalBrief: string;
}

/**
 * Steps 16–17: the handover note flag (GB3a) and the rendered brief
 * (KF-5b). A brief that does not render, or renders no numbered fix,
 * refuses.
 */
async function fixRenderHandoverStep(
  shared: FixPrepareWired,
  input: FixRenderInput,
): Promise<FixPrepareStepOutcome<{ readonly briefText: string; readonly numberedFixes: readonly string[] }>> {
  // The run's recorded branch wins (KF-5b); old records without it fall back
  // to the prior worktree path's last segment (the conductor names
  // worktrees after their branch).
  const branchName = shared.record.branchName ?? input.prior.worktreePath.split('/').pop() ?? '';
  // GB3a: when the previous FIX seat left the worktree dirty (its last
  // dispatch refused with a dirty detail and the attempt was cancelled), the
  // next fix brief opens with the handover note: finish the work and commit.
  const latestAttempt = shared.gathered.latestAttempt;
  const handover =
    lastDispatchLeftDirtyWorktree(input.entries, shared.record.runId) &&
    latestAttempt !== null &&
    latestAttempt.kind === 'fix' &&
    latestAttempt.state === 'cancelled' &&
    latestAttempt.priorAttemptId === input.prior.id;
  const brief = renderHandoverBrief({
    runId: shared.record.runId,
    round: input.round,
    branchName,
    head12: input.head,
    source: input.failure.source === 'review' ? 'review' : 'gate',
    findings: input.findings,
    gateReasonCodes: input.failure.source === 'review' ? [] : [input.failure.reasonCode],
    gatePredicates: input.gatePredicates,
    proofCommands: input.proofCommands,
    originalBrief: input.originalBrief,
    ...(handover ? { uncommittedHandover: true } : {}),
  } satisfies RenderHandoverBriefInput);
  if (!brief.ok || brief.numberedFixes.length === 0) {
    return { status: 'refused', result: await shared.refuse('prepare-refused', 'prepare-nothing-to-fix') };
  }
  return { status: 'ok', value: { briefText: brief.text, numberedFixes: brief.numberedFixes } };
}

/** The inputs of the dispatch step. */
interface FixDispatchInput {
  readonly prior: AttemptRecord;
  readonly manifest: Record<string, unknown>;
  readonly recordedHost: AttemptRunnerRecord;
  readonly briefText: string;
  readonly numberedFixes: readonly string[];
}

/**
 * Steps 18–23: mint the fix attempt id and journal its intent, place the
 * brief package, prepare the fix attempt, save the record and append the
 * completed result — in EXACTLY `performPrepare`'s order. This is the
 * terminal step: it always returns the step's result.
 */
async function fixDispatchStep(shared: FixPrepareWired, input: FixDispatchInput): Promise<AdvanceLaneRunResult> {
  const briefFixRequest: PrepareFixAttemptRequest = {
    fixAttemptId: 'attempt-' + shared.ctx.deps.newUlid(),
    workOrderId: shared.record.workOrderId,
    priorAttemptId: input.prior.id,
    numberedFixes: input.numberedFixes,
    nowIso: shared.request.nowIso,
  };
  const intentRefusal = await appendRunIntent(shared.ctx, shared.request, shared.decision.key, briefFixRequest.fixAttemptId);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  // KF-6: place the fix round's brief package from the prior attempt's
  // frozen manifest before preparing the fix attempt. The handover text is
  // the prose; it is never journalled and never stored anywhere but the
  // brief package. KF-21b: built from the digest-verified manifest read
  // above.
  const briefRequest = briefRequestFromManifest({
    manifest: input.manifest,
    fixAttemptId: briefFixRequest.fixAttemptId,
    worktreePath: input.prior.worktreePath,
    proseMarkdown: input.briefText,
    // KF-9: the brief package is placed on the reserved host of the prior
    // attempt, never on the default executor (Q2a-2): checked above.
    recordedHost: input.recordedHost,
  });
  const refusePrepared = async (detail: string): Promise<AdvanceLaneRunResult> => {
    const resultRefusal = await appendRunResult(shared.ctx, shared.request, shared.decision.key, 'refused', 'prepare-refused', detail);
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    return { outcome: 'acted', step: shared.decision.step, key: shared.decision.key, result: 'refused', reasonCode: 'prepare-refused', detail };
  };
  if (briefRequest === null) {
    return refusePrepared('prepare-brief-request-incomplete');
  }
  let briefResult: PrepareBriefPackageResult;
  try {
    briefResult = await shared.ports.prepareBrief.prepareBriefPackage(briefRequest);
  } catch {
    briefResult = { outcome: 'rejected', reason: 'prepare-refused' };
  }
  if (briefResult.outcome !== 'prepared') {
    return refusePrepared('prepare-brief-rejected');
  }
  const fixRequest: PrepareFixAttemptRequest = {
    ...briefFixRequest,
    briefDigest: briefResult.prepared.briefDigest,
    briefPackagePath: briefResult.prepared.prosePath,
  };
  let prepared: PrepareFixAttemptResult;
  try {
    // PrepareFixAttempt selects the fix seat itself; the decider's seat index is advisory until the port takes one (follow-up).
    prepared = await shared.ports.fixPort.prepareFixAttempt(fixRequest);
  } catch {
    prepared = { outcome: 'refused', reason: 'prepare-refused' };
  }
  if (prepared.outcome !== 'prepared' || prepared.attempt.id !== fixRequest.fixAttemptId) {
    return refusePrepared('prepare-fix-refused');
  }
  const saved = await saveOrRefuse(shared.ctx,
    { ...shared.record, attemptIds: [...shared.record.attemptIds, prepared.attempt.id], revision: shared.record.revision + 1 },
    shared.request,
  );
  if (!saved.ok) {
    // The intent stays pending; the prepare reconcile finds the attempt and
    // appends the id to the run record (K4-7).
    return { outcome: 'refused', reason: saved.reason };
  }
  const resultRefusal = await appendRunResult(shared.ctx, shared.request, shared.decision.key, 'completed', 'prepared');
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return { outcome: 'acted', step: shared.decision.step, key: shared.decision.key, result: 'completed', reasonCode: 'prepared' };
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
  refuse: FixPrepareRefuse,
): Promise<AdvanceLaneRunResult> {
  const shared: FixPrepareShared = { ctx, record, gathered, decision, request, refuse };
  const wiring = fixPrepareWiringStep(shared);
  if (wiring.status === 'refused') {
    return wiring.result;
  }
  const wired: FixPrepareWired = { ...shared, ports: wiring.value };
  const spent = await fixPrepareSpentKeyStep(wired);
  if (spent.status === 'refused') {
    return spent.result;
  }
  const source = await fixPreparePriorSourceStep(wired);
  if (source.status === 'refused') {
    return source.result;
  }
  const context = source.value;
  const review = await fixPrepareReviewFindingsStep(wired, context);
  if (review.status === 'refused') {
    return review.result;
  }
  const briefRead = await fixReadPriorBriefStep(wired, context.prior);
  if (briefRead.status === 'refused') {
    return briefRead.result;
  }
  const verified = await fixVerifyManifestStep(wired, gathered, context.prior, briefRead.value.prose, briefRead.value.manifestRaw);
  if (verified.status === 'refused') {
    return verified.result;
  }
  const gate = await fixPrepareGatePredicatesStep(wired, context.prior, context.failure);
  if (gate.status === 'refused') {
    return gate.result;
  }
  // KS6: beside the gate's own deltas, the review receipts already recorded at
  // the failed head join the fix brief — the first in-scope findings win, and a
  // missing, unreadable or finding-free receipt adds nothing.
  const gateFindings = await fixPrepareGateReviewFindingsStep(wired, context);
  if (gateFindings.status === 'refused') {
    return gateFindings.result;
  }
  const proof = await fixPrepareProofCommandsStep(wired, verified.value.manifest);
  if (proof.status === 'refused') {
    return proof.result;
  }
  const original = await fixPrepareOriginalBriefStep(wired, context.prior, briefRead.value.prose, verified.value.trustedHandover);
  if (original.status === 'refused') {
    return original.result;
  }
  const rendered = await fixRenderHandoverStep(wired, {
    prior: context.prior,
    entries: context.entries,
    round: context.round,
    head: context.head,
    failure: context.failure,
    findings: [...review.value, ...gateFindings.value],
    gatePredicates: gate.value,
    proofCommands: proof.value,
    originalBrief: original.value,
  });
  if (rendered.status === 'refused') {
    return rendered.result;
  }
  return fixDispatchStep(wired, {
    prior: context.prior,
    manifest: verified.value.manifest,
    recordedHost: briefRead.value.recordedHost,
    briefText: rendered.value.briefText,
    numberedFixes: rendered.value.numberedFixes,
  });
}
