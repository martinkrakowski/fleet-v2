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
import {
  DEFAULT_PREMERGE_MODE,
  effectivePremergeHold,
  type LaneRunMergeHold,
  laneRunMergeHold,
  normalizePremergeMode,
  PREMERGE_MODES,
  type PremergeMode,
} from '../../../domain/lane-run-transitions.js';

export {
  DEFAULT_PREMERGE_MODE,
  effectivePremergeHold,
  normalizePremergeMode,
  PREMERGE_MODES,
  type PremergeMode,
};
import { decideConductorReviewOutcome } from '../../../domain/lane-run-decider.js';
import { readBoundedDenseArray, snapshotPlainDataRecord } from '../../../domain/plain-record-reads.js';
import { buildLaneRunStepKey, head12Of, parseLaneRunKey, LANE_RUN_MAX_RETRY } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { premergeCarryMatches, type PremergeCarry } from '../../../domain/receipt-carry.js';
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

/**
 * RM3: the receiver's own data property `key`, read through its property
 * descriptor — a getter or setter is never run (`undefined` instead). Total
 * and `O(1)`: one descriptor read, `undefined` on a missing key, an
 * accessor, a `null`/primitive source, or a throwing trap.
 */
function ownDataProp(source: unknown, key: string): unknown {
  try {
    if (source === null || typeof source !== 'object') {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/** A plain object (prototype `Object.prototype` or `null`); anything else is hostile. */
function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * U6: the verified base-merge carry for this PR head, or null. The gathered
 * fact (journalled or qualified by `qualifyBaseMergeCarry`) must carry exactly
 * from the reviewed lane head `headSha` to the PR head the forge reports, at
 * full sha precision; anything else is no carry. `O(1)`, no getter run.
 */
function activeCarryOf(gathered: GatheredLaneRunFacts, headSha: string): PremergeCarry | null {
  const carry = gathered.facts.premergeCarry;
  const prHeadSha = ownDataProp(gathered.facts.pr, 'headSha');
  return premergeCarryMatches(carry, headSha, typeof prHeadSha === 'string' ? prHeadSha : null) ? carry : null;
}

/** The findings count above which a receipt is refused (`O(1)` before any element read). */
const RM3_FINDINGS_MAX = 999;

/**
 * RM3: the Tier 2 release gate over the merge hold. `true` for Tier 1
 * (unchanged). For Tier 2 it requires, in `O(1)` fixed descriptor reads (no
 * iteration, no getter run):
 * - the run is not parked `owner-merge`;
 * - the automated pre-merge review either did not run or passed
 *   (correction 8: `preMergeReview.verdict` is `none` or `passed`; any other
 *   verdict waits);
 * - an accepted owner receipt (`requestId === null`) at the exact head exists;
 * - the PR's current head is the candidate head at full sha precision
 *   (`facts.pr.headSha === headSha`, fix round 1: a 12-character prefix alone
 *   passes for distinct heads that share it, so the full forge-reported head
 *   sha is required; a pr fact without `headSha` reads as unknown and never
 *   releases).
 * Without them the hold stays `wait`/`pending` — `premerge` `success` is
 * never published while parked `owner-merge` or without the exact-head owner
 * receipt.
 */
function tier2OwnerPremergeReleased(
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  headSha: string,
  receipt: ReviewReceiptOfKind | null,
): boolean {
  if (record.tier !== 2) {
    return true;
  }
  if (
    record.parked !== null &&
    record.parked !== undefined &&
    ownDataProp(record.parked, 'reason') === 'owner-merge'
  ) {
    return false;
  }
  const reviewVerdict =
    gathered.facts.preMergeReview === undefined
      ? 'none'
      : ownDataProp(gathered.facts.preMergeReview, 'verdict');
  if (reviewVerdict !== 'none' && reviewVerdict !== 'passed') {
    return false;
  }
  if (
    receipt === null ||
    ownDataProp(receipt, 'requestId') !== null ||
    ownDataProp(receipt, 'candidateHeadSha') !== headSha
  ) {
    return false;
  }
  // Fix round 1: compare the PR head at full sha precision. `headSha` is a
  // validated 40-hex read (`O(1)` descriptor read, no getter); a pr fact
  // without it, or with a different head — even one sharing the 12-character
  // prefix — never releases the hold.
  // U6: a PR head that moved only by a verified clean base merge (a carry from
  // the reviewed head to this exact PR head) is released by the same receipt at
  // the reviewed head; the receipt itself is never rewritten.
  if (
    gathered.facts.pr === null ||
    (ownDataProp(gathered.facts.pr, 'headSha') !== headSha && activeCarryOf(gathered, headSha) === null)
  ) {
    return false;
  }
  return true;
}

/**
 * RM3: the receipt's findings as a fresh dense snapshot of plain data objects,
 * read only through property descriptors — no getter ever runs. `O(1)` to
 * refuse a non-array, an accessor-backed or huge `length` (the same 999 bound
 * as the fail-hold check), then the accepted engine bound of
 * `readBoundedDenseArray` plus `O(findings)` element snapshots. A hole, an
 * accessor, a non-plain finding, a Proxy lie, or a `__proto__` key refuses
 * with null; the caller publishes no success on null.
 */
function findingsSnapshotOf(
  receipt: Record<string, unknown>,
): readonly Record<string, unknown>[] | null {
  const findings = readBoundedDenseArray(receipt.findings, RM3_FINDINGS_MAX);
  if (findings === null) {
    return null;
  }
  const snapshot: Record<string, unknown>[] = [];
  for (const finding of findings.array) {
    const plain = snapshotPlainDataRecord(finding);
    if (plain === null) {
      return null;
    }
    snapshot.push(plain);
  }
  return snapshot;
}

/**
 * RM3: the receipt's typed shape rebuilt from the snapshot, so every field
 * downstream (`receiptId` for the fail-hold grant, `findings` for the count)
 * is data-only. A missing or wrong-typed field refuses with null.
 */
function typedReceiptOf(
  snapshot: Record<string, unknown>,
  findings: readonly Record<string, unknown>[],
): ReviewReceiptOfKind | null {
  const receiptId = ownDataProp(snapshot, 'receiptId');
  const requestId = ownDataProp(snapshot, 'requestId');
  const reviewerModel = ownDataProp(snapshot, 'reviewerModel');
  const candidateHeadSha = ownDataProp(snapshot, 'candidateHeadSha');
  const verdict = ownDataProp(snapshot, 'verdict');
  const unknownReason = ownDataProp(snapshot, 'unknownReason');
  if (
    typeof receiptId !== 'string' ||
    (requestId !== null && typeof requestId !== 'string') ||
    typeof reviewerModel !== 'string' ||
    typeof candidateHeadSha !== 'string' ||
    (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'unknown')
  ) {
    return null;
  }
  return {
    receiptId,
    requestId,
    kind: 'pre-merge',
    reviewerModel,
    candidateHeadSha,
    verdict,
    findings: findings as unknown as ReviewReceiptOfKind['findings'],
    ...(typeof unknownReason === 'string'
      ? { unknownReason: unknownReason as ReviewReceiptOfKind['unknownReason'] }
      : {}),
  };
}

/**
 * The re-read receipt's verdict at the exact head, like `preMergeFactOf` (RV3:
 * severity-derived). Every field of the port's answer is read through its own
 * property descriptor (`O(1)` per field, no getter ever runs); the receipt is
 * snapshotted once (`O(own keys)`, the accepted engine bound) and its findings
 * through `findingsSnapshotOf` (RM3, `O(≤ 999)`). Any getter-backed,
 * malformed, sparse, wrong-primitive, `__proto__`-keyed or Proxy-lying shape
 * refuses with `{ receipt: null, verdict: 'unknown' }` — never a pass.
 */
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
    const outcome = ownDataProp(read, 'outcome');
    if (outcome !== 'found') {
      return { receipt: null, verdict: outcome === 'not-found' ? 'none' : 'unknown' };
    }
    const receipt = ownDataProp(read, 'receipt');
    if (!isPlainObjectValue(receipt)) {
      return { receipt: null, verdict: 'unknown' };
    }
    const snapshot = snapshotPlainDataRecord(receipt);
    if (snapshot === null) {
      return { receipt: null, verdict: 'unknown' };
    }
    // A receipt of another kind or head never authorises a post on this head.
    if (ownDataProp(snapshot, 'kind') !== 'pre-merge' || ownDataProp(snapshot, 'candidateHeadSha') !== headSha) {
      return { receipt: null, verdict: 'unknown' };
    }
    const findings = findingsSnapshotOf(snapshot);
    if (findings === null) {
      return { receipt: null, verdict: 'unknown' };
    }
    const typed = typedReceiptOf(snapshot, findings);
    if (typed === null) {
      return { receipt: null, verdict: 'unknown' };
    }
    // RV3: the severity outcome decides — a minor-only `failed` receipt
    // releases the hold, a 0-finding `failed` receipt is unknown. Only the
    // data-only snapshot reaches the decider (RM3): a getter that replaces an
    // index with a finding can never run.
    return { receipt: typed, verdict: decideConductorReviewOutcome({ ...snapshot, findings }).outcome };
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
  carry: PremergeCarry | null,
): Promise<AdvanceLaneRunResult> {
  // U6: a carried release is posted at the PR head (`toHeadSha`); the grant,
  // the action and the status are all pinned to it, and the action names the
  // reviewed head it was carried from so the use case checks the attempt there.
  const postHeadSha = carry === null ? headSha : carry.toHeadSha;
  const conductorForgeGrant = ctx.deps.conductorForgeGrant;
  const executeForgeAction = ctx.deps.executeForgeAction;
  const actionId = 'forge-' + ctx.deps.newUlid();
  if (appendIntent) {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, actionId, carry ?? undefined);
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
      expectedHeadSha: postHeadSha,
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
    expectedHeadSha: postHeadSha,
    ...(carry === null ? {} : { carriedFromHeadSha: headSha }),
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
  const carry = activeCarryOf(gathered, headSha);
  if (carry !== null && decision.head12 !== head12Of(carry.toHeadSha)) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const read = await premergeVerdictOf(ctx, latest, headSha);
  const rawHold = laneRunMergeHold(record.tier, read.verdict, record.round);
  if (
    rawHold.kind === 'park' ||
    read.verdict !== gathered.facts.preMerge ||
    (rawHold.kind === 'fail' && (read.receipt === null || read.receipt.findings.length > 999))
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
  // AP1: the mode gate applies after the ambiguity checks, so a corrupt or
  // ambiguous receipt still parks in both modes; only a released Tier 2 hold
  // downgrades to `wait` under `human-gate`.
  const modeHold = effectivePremergeHold(rawHold, record.tier, ctx.deps.premergeMode);
  // RM3: on top of the mode gate, a Tier 2 `released` hold publishes success
  // only with the exact-head owner receipt and no parked `owner-merge`; a
  // Tier 1 hold is unchanged (the gate reads `true`). Without it the hold
  // stays `wait`/`pending` in both modes.
  const hold =
    modeHold.kind === 'released' && !tier2OwnerPremergeReleased(record, gathered, headSha, read.receipt)
      ? ({ kind: 'wait', status: 'pending' } as LaneRunMergeHold)
      : modeHold;
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
    carry,
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
  // U6: when a verified carry moved the effective head to the PR head, the key
  // for that head is the live one and the pending post at the reviewed head's
  // key is overtaken (the next advance posts under the carried head's key).
  const reviewedHeadSha = gathered.latestAttempt?.artifacts?.headCommit;
  const carry = typeof reviewedHeadSha === 'string' ? activeCarryOf(gathered, reviewedHeadSha) : null;
  const liveHead12 = carry === null ? gathered.facts.head12 : head12Of(carry.toHeadSha);
  if (parsed === null || parsed.kind !== 'premerge' || parsed.head12 !== liveHead12) {
    return appendPremergeResult(ctx, request, decision, 'overtaken', 'premerge-overtaken');
  }
  const rawFactHold = laneRunMergeHold(record.tier, gathered.facts.preMerge, record.round);
  if (rawFactHold.kind === 'park') {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  // RM3: a Tier 2 run parked `owner-merge` never publishes success: it keeps
  // waiting on the exact-head owner receipt with no grant and no forge call.
  if (record.tier === 2 && record.parked !== null && record.parked.reason === 'owner-merge') {
    return { outcome: 'waiting', reason: 'premerge-pending' };
  }
  // AP1: the mode gate applies on the gathered fact hold too, so a pending
  // intent under a released fact stays `premerge-pending` under `human-gate`.
  const factHold = effectivePremergeHold(rawFactHold, record.tier, ctx.deps.premergeMode);
  if (factHold.kind === 'wait') {
    return { outcome: 'waiting', reason: 'premerge-pending' };
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
  const rawHold = laneRunMergeHold(record.tier, read.verdict, record.round);
  if (rawHold.kind === 'park') {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  if (rawHold.kind === 'fail' && (read.receipt === null || read.receipt.findings.length > 999)) {
    return appendPremergeResult(ctx, request, decision, 'ambiguous', 'review-unknown');
  }
  // AP1: the re-read hold is gated the same way as the fact hold; a released
  // Tier 2 hold under `human-gate` keeps waiting with no grant and no post.
  const modeHold = effectivePremergeHold(rawHold, record.tier, ctx.deps.premergeMode);
  // RM3: the same Tier 2 owner-receipt gate as the act, on top of the mode
  // gate: a released Tier 2 hold without the exact-head owner receipt keeps
  // waiting with no grant and no forge call.
  const hold =
    modeHold.kind === 'released' && !tier2OwnerPremergeReleased(record, gathered, headSha, read.receipt)
      ? ({ kind: 'wait', status: 'pending' } as LaneRunMergeHold)
      : modeHold;
  if (hold.kind === 'wait') {
    return { outcome: 'waiting', reason: 'premerge-pending' };
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
    carry,
  );
}
