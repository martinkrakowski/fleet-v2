/**
 * KS7a-2: the conductor's `premerge` commit-status act and reconcile (speed
 * plan §3.3.1, §3.6.2; D20). One run-journal key per head
 * `<runId>/r<round>/premerge@<head12>` (from `laneRunPremergeKey`), posted on
 * the exact head by the conductor's existing forge identity. A `wait` hold
 * posts `pending` once under one intent and one conductor grant and appends no
 * result; a `released` or `fail` hold posts `success` / `failure` and appends
 * one final result. The reconcile never posts a second intent and never calls
 * the forge for a pending hold, a moved head, a park hold or a receipt that
 * disagrees with the hold. No forge call from this use case itself: the
 * composed adapter posts.
 */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { ExecuteAuthorizedForgeActionResult, ExecuteAuthorizedForgeActionRequest } from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { ConductorForgeGrantResult } from '../../ports/out/ConductorForgeGrantPort.out-port.js';
import type { ReviewReceiptOfKind } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import { laneRunMergeHold } from '../../../domain/lane-run-transitions.js';
import type { LaneRunMergeHold } from '../../../domain/lane-run-transitions.js';
import { decideConductorReviewOutcome } from '../../../domain/lane-run-decider.js';
import { buildLaneRunStepKey, parseLaneRunKey, LANE_RUN_MAX_RETRY } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, performEnter, refusedResult } from './step-context.js';

type ActDecision = Extract<LaneRunDecision, { kind: 'act' }>;
type ReconcileDecision = Extract<LaneRunDecision, { kind: 'reconcile' }>;

const PREMERGE_CONTEXT = 'premerge' as const;

/** The exact 40-lowercase-hex head the post is pinned to (KS7a-2). */
const HEX_40_PATTERN = /^[0-9a-f]{40}$/;

/** The fixed status state and description of the `premerge` post (§3.3.1). */
function premergeStatusOf(
  hold: LaneRunMergeHold,
  tier: LaneRunRecord['tier'],
  findings: number,
): { readonly state: 'success' | 'pending' | 'failure'; readonly description: string } {
  if (hold.kind === 'wait') {
    return { state: 'pending', description: 'waiting for the pre-merge review' };
  }
  if (hold.kind === 'fail') {
    return { state: 'failure', description: `findings: ${findings}` };
  }
  return { state: 'success', description: tier === 1 ? 'not required for tier 1' : 'pre-merge receipt recorded' };
}

/** The one final journal result of a released or fail hold. */
function terminalResultOf(
  hold: LaneRunMergeHold,
): { readonly outcome: 'completed'; readonly reasonCode: 'premerge-success' | 'premerge-failure' } {
  return hold.kind === 'fail'
    ? { outcome: 'completed', reasonCode: 'premerge-failure' }
    : { outcome: 'completed', reasonCode: 'premerge-success' };
}

/** Append a result under the pending key and report the acted outcome; a journal refusal refuses. */
async function appendPremergeResult(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ActDecision | ReconcileDecision,
  outcome: 'completed' | 'refused' | 'ambiguous' | 'overtaken',
  reasonCode: LaneRunResultReasonCode,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
}

/** A pre-execution refusal: an intent (minted id null) then a refused result; nothing external is called. */
async function refuseKeyedPremerge(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ActDecision,
  reasonCode: Extract<LaneRunResultReasonCode, 'forge-refused' | 'grant-refused'>,
): Promise<AdvanceLaneRunResult> {
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  return appendPremergeResult(ctx, request, decision, 'refused', reasonCode);
}

/** The grant's acceptance receipt id. A `fail` hold is authorised by the
 * re-read FAILED pre-merge receipt itself (its own receipt id, never a
 * receipts pass); a `wait` or `released` hold is authorised by the receipts
 * pass (`premergeReceiptIdOf`). Null refuses the grant. */
function premergeAuthorisationReceiptIdOf(
  ctx: AdvanceStepContext,
  latest: { readonly id: string },
  record: LaneRunRecord,
  headSha: string,
  hold: LaneRunMergeHold,
  receipt: ReviewReceiptOfKind | null,
): Promise<string | null> {
  if (hold.kind === 'fail') {
    return Promise.resolve(receipt === null ? null : receipt.receiptId);
  }
  return premergeReceiptIdOf(ctx, latest, record, headSha);
}

/** The receipts-pass receipt id, read like `runPrPushBody` at the exact head; null refuses the grant. */
async function premergeReceiptIdOf(
  ctx: AdvanceStepContext,
  latest: { readonly id: string },
  record: LaneRunRecord,
  headSha: string,
): Promise<string | null> {
  const assessment = ctx.deps.acceptanceAssessment;
  if (assessment === undefined) {
    return null;
  }
  try {
    const read = await assessment.assessHeadReceipts({
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      candidateHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
    });
    return read.outcome === 'passed' && read.assessedHeadSha === headSha ? read.receiptsId : null;
  } catch {
    return null;
  }
}

/** The blocking (`blocker`/`major`) finding count of a receipt (RV3). */
function blockingFindingsCountOf(findings: readonly { readonly severity: string }[]): number {
  return findings.filter((finding) => finding.severity === 'blocker' || finding.severity === 'major').length;
}

/** The re-read receipt's verdict at the exact head, like `preMergeFactOf` (RV3: severity-derived). */
async function premergeVerdictOf(
  ctx: AdvanceStepContext,
  latest: { readonly id: string },
  headSha: string,
): Promise<{ readonly receipt: ReviewReceiptOfKind | null; readonly verdict: 'none' | 'passed' | 'failed' | 'unknown' }> {
  const reviewRequest = ctx.deps.reviewRequest;
  if (reviewRequest === undefined) {
    return { receipt: null, verdict: 'unknown' };
  }
  try {
    const read = await reviewRequest.findLatestReceiptOfKind({
      attemptId: latest.id,
      candidateHeadSha: headSha,
      kind: 'pre-merge',
    });
    if (read.outcome === 'found') {
      // A receipt of another kind or head never authorises a post on this head.
      if (read.receipt.kind !== 'pre-merge' || read.receipt.candidateHeadSha !== headSha) {
        return { receipt: null, verdict: 'unknown' };
      }
      // RV3: the severity outcome decides — a minor-only `failed` receipt
      // releases the hold, a 0-finding `failed` receipt is unknown.
      return { receipt: read.receipt, verdict: decideConductorReviewOutcome(read.receipt).outcome };
    }
    return { receipt: null, verdict: read.outcome === 'not-found' ? 'none' : 'unknown' };
  } catch {
    return { receipt: null, verdict: 'unknown' };
  }
}

/** Mint the action id, append the intent (act only), issue the grant and
 * execute the post. The `wait` and `released` posts are authorised by the
 * receipts pass (`premergeReceiptIdOf`); the `fail` post is authorised by the
 * failed pre-merge receipt itself (`premergeAuthorisationReceiptIdOf`). */
async function postPremerge(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: { readonly id: string },
  headSha: string,
  workOrder: WorkOrderRecord,
  hold: LaneRunMergeHold,
  decision: ActDecision | ReconcileDecision,
  request: AdvanceLaneRunRequest,
  appendIntent: boolean,
  findings: number,
  receiptId: string,
): Promise<AdvanceLaneRunResult> {
  const conductorForgeGrant = ctx.deps.conductorForgeGrant;
  const executeForgeAction = ctx.deps.executeForgeAction;
  const actionId = 'forge-' + ctx.deps.newUlid();
  if (appendIntent) {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, actionId);
    if (intentRefusal !== null) {
      return refusedResult(intentRefusal);
    }
  }
  const refuseGrant = async (): Promise<AdvanceLaneRunResult> =>
    appendPremergeResult(ctx, request, decision, 'refused', 'grant-refused');
  let grant: ConductorForgeGrantResult;
  try {
    grant = await conductorForgeGrant!.issueConductorForgeGrant({
      projectId: workOrder.projectId,
      workOrderId: record.workOrderId,
      attemptId: latest.id,
      forgeKind: 'post-status',
      expectedHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
      acceptanceReceiptId: receiptId,
    });
  } catch {
    return refuseGrant();
  }
  if (grant.outcome !== 'issued') {
    return refuseGrant();
  }
  const status = premergeStatusOf(hold, record.tier, findings);
  const forgeRequest: ExecuteAuthorizedForgeActionRequest = {
    actionId,
    attemptId: latest.id,
    workOrderId: record.workOrderId,
    kind: 'post-status',
    expectedHeadSha: headSha,
    authorizationGrantId: grant.grantId,
    authorizedBy: grant.decisionRevision,
    branchName: record.branchName,
    status: { context: PREMERGE_CONTEXT, state: status.state, description: status.description },
  };
  let forged: ExecuteAuthorizedForgeActionResult;
  try {
    forged = await executeForgeAction!.executeAuthorizedForgeAction(forgeRequest);
  } catch {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
  }
  if ((forged as { forgeAmbiguous?: true }).forgeAmbiguous === true) {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
  }
  if (forged.outcome !== 'executed') {
    return appendPremergeResult(ctx, request, decision, 'refused', 'forge-refused');
  }
  if (hold.kind === 'wait') {
    // Pending posted once: no final result, so the intent stays unread and the
    // reconcile re-reads the hold; it never posts again under this key.
    return { outcome: 'waiting', reason: 'premerge-pending' };
  }
  const terminal = terminalResultOf(hold);
  return appendPremergeResult(ctx, request, decision, terminal.outcome, terminal.reasonCode);
}

/**
 * The `act premerge` step (KS7a-2): re-read the pre-merge receipt, read the
 * merging hold from it, then post the status. A `wait` hold posts `pending`
 * (one intent, one grant, no result); a `released` or `fail` hold posts the
 * terminal status and appends one final result. A park hold, a failure count
 * over 999, a missing branch, wiring or a missing work order posts nothing.
 */
export async function performPremerge(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  if (
    ctx.deps.conductorForgeGrant === undefined ||
    ctx.deps.executeForgeAction === undefined ||
    ctx.deps.workOrderRepo === undefined ||
    ctx.deps.reviewRequest === undefined
  ) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  if (record.branchName === undefined) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const headSha = latest.artifacts.headCommit;
  if (!HEX_40_PATTERN.test(headSha)) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  let workOrder: WorkOrderRecord | null;
  try {
    workOrder = await ctx.deps.workOrderRepo!.findWorkOrderById(record.workOrderId);
  } catch {
    workOrder = null;
  }
  if (workOrder === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const read = await premergeVerdictOf(ctx, latest, headSha);
  const hold = laneRunMergeHold(record.tier, read.verdict, record.round);
  if (
    hold.kind === 'park' ||
    read.verdict !== gathered.facts.preMerge ||
    (hold.kind === 'fail' && (read.receipt === null || read.receipt.findings.length > 999))
  ) {
    // Nothing is posted: an ambiguous result under a fresh intent (the next
    // tick parks); never a forge call.
    const actionId = 'forge-' + ctx.deps.newUlid();
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, actionId);
    if (intentRefusal !== null) {
      return refusedResult(intentRefusal);
    }
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  const receiptId = await premergeAuthorisationReceiptIdOf(ctx, latest, record, headSha, hold, read.receipt);
  if (receiptId === null) {
    return refuseKeyedPremerge(ctx, request, decision, 'grant-refused');
  }
  return postPremerge(
    ctx,
    record,
    latest,
    headSha,
    workOrder,
    hold,
    decision,
    request,
    true,
    blockingFindingsCountOf(read.receipt?.findings ?? []),
    receiptId,
  );
}

/**
 * True when `key` already carries a recorded CI failure result (`ci-failed`).
 * An overtaken (`ci-overtaken`) final result never counts as a recorded CI failure.
 */
async function ciFinalResultOf(ctx: AdvanceStepContext, key: string): Promise<boolean> {
  const entries = await ctx.deps.runJournal.listForKey(key);
  return entries.some((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous' && entry.reasonCode === 'ci-failed');
}

/**
 * Resolves the key under which a CI failure should be acted / recorded.
 *
 * If `initialKey` already has a recorded `ci-failed` result, returns `already-recorded`
 * so only the missing transition to `fixing` is performed.
 * If `initialKey` has no intent yet, returns `fresh`.
 * If `initialKey` is already spent without a CI failure (e.g. overtaken because CI
 * previously passed), walks the key family's retry suffixes (`/retry1`..`/retry9`)
 * to find the first candidate that is either already recorded with `ci-failed` or
 * completely fresh.
 */
async function resolveCiFailureKey(
  ctx: AdvanceStepContext,
  initialKey: string,
): Promise<{ readonly kind: 'already-recorded'; readonly key: string } | { readonly kind: 'fresh'; readonly key: string } | null> {
  if (await ciFinalResultOf(ctx, initialKey)) {
    return { kind: 'already-recorded', key: initialKey };
  }
  const initialEntries = await ctx.deps.runJournal.listForKey(initialKey);
  if (!initialEntries.some((entry) => entry.kind === 'intent')) {
    return { kind: 'fresh', key: initialKey };
  }
  const parsed = parseLaneRunKey(initialKey);
  if (parsed === null || parsed.kind !== 'step') {
    return null;
  }
  for (let retry = (parsed.retry ?? 0) + 1; retry <= LANE_RUN_MAX_RETRY; retry += 1) {
    const built = buildLaneRunStepKey({
      runId: parsed.runId,
      round: parsed.round,
      step: parsed.step,
      seatIndex: parsed.seatIndex,
      attemptOrdinal: parsed.attemptOrdinal,
      head12: parsed.head12,
      retry,
    });
    if (!built.ok) {
      continue;
    }
    const candidateKey = built.key;
    if (await ciFinalResultOf(ctx, candidateKey)) {
      return { kind: 'already-recorded', key: candidateKey };
    }
    const candidateEntries = await ctx.deps.runJournal.listForKey(candidateKey);
    if (!candidateEntries.some((entry) => entry.kind === 'intent')) {
      return { kind: 'fresh', key: candidateKey };
    }
  }
  return null;
}

/**
 * GB4: record the CI failure under the `ci` key and enter `fixing`.
 * The intent is already journalled (the act wrote it; the reconcile never
 * writes a second one). The write order is result, then the conduct entry
 * of the transition, so a crash between the two leaves the run in
 * `watching-ci` with the result recorded — the decider's `ciFailureRecorded`
 * fact then resumes only the transition.
 */
export async function recordCiFailure(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision | ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'ci-failed');
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return enterFixingAfterCi(ctx, record, gathered, decision, request);
}

/** The transition part of a recorded CI failure: enter `fixing` and report the acted shape. */
async function enterFixingAfterCi(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision | ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const entered = await performEnter(ctx, record, gathered.facts.state, 'fixing', request);
  if (entered.outcome !== 'entered') {
    return entered;
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'ci-failed' };
}

/**
 * The `act ci` step (GB4): the CI failure at the exact head becomes a
 * keyed `refused` / `ci-failed` result and the run enters `fixing`. A key
 * that already carries its final result is never written again: only the
 * missing transition is performed.
 *
 * When a prior pending CI intent at the same head was reconciled as
 * overtaken (e.g. CI passed before a subsequent rerun failed), the spent
 * key is never reused for a new intent: a fresh retry key (`/retry<n>`)
 * is journalled instead, and the run enters fixing with that failure source.
 */
export async function performCiFailure(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const resolved = await resolveCiFailureKey(ctx, decision.key);
  if (resolved === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const keyDecision = { ...decision, key: resolved.key };
  if (resolved.kind === 'already-recorded') {
    return enterFixingAfterCi(ctx, record, gathered, keyDecision, request);
  }
  const intentRefusal = await appendRunIntent(ctx, request, resolved.key, null);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  return recordCiFailure(ctx, record, gathered, keyDecision, request);
}

/**
 * The premerge reconcile (§3.5): an intent without a result is settled, never
 * repeated. A moved head appends `overtaken` / `premerge-overtaken`; a pending
 * hold returns `premerge-pending` with no grant and no execute; a park hold, a
 * receipt that disagrees with the hold, or a failure count over 999 appends
 * `ambiguous` / `review-unknown`; otherwise the terminal post runs under a NEW
 * grant and a NEW action id (the intent's minted id stays), then one final
 * result.
 */
export async function reconcilePremerge(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const parsed = parseLaneRunKey(decision.key);
  if (parsed === null || parsed.kind !== 'premerge' || parsed.head12 !== gathered.facts.head12) {
    return appendPremergeResult(ctx, request, decision, 'overtaken', 'premerge-overtaken');
  }
  const hold = laneRunMergeHold(record.tier, gathered.facts.preMerge, record.round);
  if (hold.kind === 'wait') {
    return { outcome: 'waiting', reason: 'premerge-pending' };
  }
  if (hold.kind === 'park') {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  if (
    ctx.deps.conductorForgeGrant === undefined ||
    ctx.deps.executeForgeAction === undefined ||
    ctx.deps.workOrderRepo === undefined ||
    ctx.deps.reviewRequest === undefined
  ) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  if (record.branchName === undefined) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const headSha = latest.artifacts.headCommit;
  if (!HEX_40_PATTERN.test(headSha)) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const read = await premergeVerdictOf(ctx, latest, headSha);
  if (read.verdict !== gathered.facts.preMerge) {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  if (hold.kind === 'fail' && (read.receipt === null || read.receipt.findings.length > 999)) {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  let workOrder: WorkOrderRecord | null;
  try {
    workOrder = await ctx.deps.workOrderRepo!.findWorkOrderById(record.workOrderId);
  } catch {
    workOrder = null;
  }
  if (workOrder === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const receiptId = await premergeAuthorisationReceiptIdOf(ctx, latest, record, headSha, hold, read.receipt);
  if (receiptId === null) {
    return appendPremergeResult(ctx, request, decision, 'refused', 'grant-refused');
  }
  return postPremerge(
    ctx,
    record,
    latest,
    headSha,
    workOrder,
    hold,
    decision,
    request,
    false,
    blockingFindingsCountOf(read.receipt?.findings ?? []),
    receiptId,
  );
}
