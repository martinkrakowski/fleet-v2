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
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult } from './step-context.js';

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
    return { outcome: 'refused', reason: resultRefusal };
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
    return { outcome: 'refused', reason: intentRefusal };
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

/** The verdict of one re-read receipt: passed/failed/unknown (anything else is unknown). */
function verdictOfReceipt(verdict: Readonly<ReviewReceiptOfKind['verdict']>): 'passed' | 'failed' | 'unknown' {
  if (verdict === 'passed') {
    return 'passed';
  }
  if (verdict === 'failed') {
    return 'failed';
  }
  return 'unknown';
}

/** The re-read receipt's verdict at the exact head, like `preMergeFactOf`. */
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
      return { receipt: read.receipt, verdict: verdictOfReceipt(read.receipt.verdict) };
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
      return { outcome: 'refused', reason: intentRefusal };
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
  if (hold.kind === 'park' || (hold.kind === 'fail' && (read.receipt === null || read.receipt.findings.length > 999))) {
    // Nothing is posted: an ambiguous result under a fresh intent (the next
    // tick parks); never a forge call.
    const actionId = 'forge-' + ctx.deps.newUlid();
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, actionId);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
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
    read.receipt?.findings.length ?? 0,
    receiptId,
  );
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
    read.receipt?.findings.length ?? 0,
    receiptId,
  );
}
