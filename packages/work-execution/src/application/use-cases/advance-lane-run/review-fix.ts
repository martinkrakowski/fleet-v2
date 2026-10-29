/** The conductor's review and fix-round acts (K5). */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { ReviewRequestKind, ReviewRequestResult } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunReviewFact } from '../../../domain/lane-run-review-facts.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision, LaneRunReviewFact, LaneRunSeatFact } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { historyEntryOf, selectReviewSeat } from '../../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import { readFrozenManifest } from './frozen-manifest.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult } from './step-context.js';

/**
 * The review facts of one advance (K5, plan §3.4): the per-kind journal facts
 * (`briefCheck`, `codeReview`) plus the review seat. Pure except
 * `ctx.deps.sameModelFamily`; nothing throws. D10 first: a recorded
 * `review-failed` result for the kind pins its LATEST seat across any head,
 * never a new seat; an index outside the plan reads `{ ok: false }`.
 */
export async function reviewFactsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  state: LaneRunStateValue,
  entries: readonly LaneRunJournalEntryRecord[],
  head12: string | null,
  attemptRecords: readonly (AttemptRecord | null)[],
): Promise<{ reviewSeat: LaneRunSeatFact; briefCheck: LaneRunReviewFact; codeReview: LaneRunReviewFact }> {
  const briefCheck = laneRunReviewFact(entries, record.runId, 'brief-check', head12);
  const codeReview = laneRunReviewFact(entries, record.runId, 'code-review', head12);
  let reviewSeat: LaneRunSeatFact = { ok: false };
  if (state === 'brief-check' || state === 'code-review') {
    const kind = state;
    const latest = [...attemptRecords].reverse().find((attempt): attempt is AttemptRecord => attempt !== null) ?? null;
    const planResult = latest === null ? { success: false as const } : SeatPlan.create(latest.seatPlan);
    if (planResult.success && planResult.value !== undefined) {
      const plan = planResult.value;
      const implementerModels: string[] = [];
      for (const attempt of attemptRecords) {
        if (attempt !== null) {
          const model = historyEntryOf(attempt).model;
          if (model !== null) {
            implementerModels.push(model);
          }
        }
      }
      // D10 first, independent of the family comparison: a recorded fail pins
      // its seat even when `sameModelFamily` is unbound (Luna, K5-4a review).
      let d10SeatIndex: number | null = null;
      for (const entry of entries) {
        if (
          entry.kind === 'result' &&
          entry.runId === record.runId &&
          entry.reasonCode === 'review-failed' &&
          entry.key !== null
        ) {
          const parsed = parseLaneRunKey(entry.key);
          if (parsed !== null && parsed.kind === 'step' && parsed.step === kind) {
            d10SeatIndex = parsed.seatIndex;
          }
        }
      }
      const sameFamily = ctx.deps.sameModelFamily;
      if (d10SeatIndex !== null) {
        reviewSeat =
          d10SeatIndex < plan.getSeats('review').length
            ? { ok: true, seatIndex: d10SeatIndex }
            : { ok: false };
      } else if (sameFamily !== undefined) {
        const selected = selectReviewSeat({ plan, round: record.round, implementerModels, sameFamily });
        reviewSeat = selected.ok ? { ok: true, seatIndex: selected.seatIndex } : { ok: false };
      }
    }
  }
  return { reviewSeat, briefCheck, codeReview };
}

/**
 * The `act brief-check` and `act code-review` steps (K5, plan §3.3, §3.4):
 * one review through `ReviewRequestPort` under a journalled request id, after
 * opening the evidence assessment through `ReviewAssessmentPort`. Only reason
 * codes are journalled, never reply text or findings; an `unknown` outcome or
 * a throw leaves the intent pending (`ambiguous`), which K5-4b reconciles.
 */
export async function performReview(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const review = ctx.deps.reviewRequest;
  const assessment = ctx.deps.reviewAssessment;
  const workOrderRepo = ctx.deps.workOrderRepo;
  if (review === undefined || assessment === undefined || workOrderRepo === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const workOrder = await workOrderRepo.findWorkOrderById(record.workOrderId);
  if (workOrder === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const refuse = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
  };
  const planResult = SeatPlan.create(latest.seatPlan);
  const reviewerSeat =
    planResult.success && planResult.value !== undefined
      ? planResult.value.getSeats('review')[decision.seatIndex]
      : undefined;
  if (reviewerSeat === undefined) {
    return refuse('review-seat-unavailable');
  }
  const implementerModel = historyEntryOf(latest).model;
  if (implementerModel === null) {
    return refuse('review-refused');
  }
  const requestId = 'review-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, requestId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  const manifest = await readFrozenManifest(latest, ctx.deps.artifactPort);
  const requiredChecks = manifestAcceptanceChecks(manifest);
  if (requiredChecks === null) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'assessment-unavailable');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'assessment-unavailable' };
  }
  const opened = await assessment.openReviewAssessment({
    attemptId: latest.id,
    projectId: workOrder.projectId,
    candidateHeadSha: latest.artifacts.headCommit,
    policyRevision: record.runPolicyRevision,
    implementerModel,
    requiredChecks,
  });
  if (opened.outcome !== 'open') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'assessment-unavailable');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'assessment-unavailable' };
  }
  let briefText: string | undefined;
  if (decision.step === 'brief-check') {
    const read = await ctx.deps.artifactPort.readBriefFile?.(latest.worktreePath, '.lane/brief.md', latest.runner ?? null);
    if (read !== undefined && read !== null) {
      briefText = read;
    }
  }
  let outcome: ReviewRequestResult;
  try {
    outcome = await review.requestReview({
      requestId,
      kind: decision.step as ReviewRequestKind,
      attemptId: latest.id,
      projectId: workOrder.projectId,
      candidateHeadSha: latest.artifacts.headCommit,
      policyRevision: record.runPolicyRevision,
      implementerModel,
      reviewerModel: reviewerSeat.model,
      ...(briefText !== undefined ? { briefText } : {}),
      nowIso: request.nowIso,
    });
  } catch {
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'review-unknown' };
  }
  if (outcome.outcome === 'unknown') {
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'review-unknown' };
  }
  if (outcome.outcome === 'no-receipt') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'review-no-receipt');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'review-no-receipt' };
  }
  if (outcome.outcome === 'refused') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'review-refused');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'review-refused' };
  }
  if (outcome.receipt.verdict === 'passed') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'review-passed');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'review-passed' };
  }
  if (outcome.receipt.verdict === 'failed') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'review-failed');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'review-failed' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'review-unknown');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'review-unknown' };
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
