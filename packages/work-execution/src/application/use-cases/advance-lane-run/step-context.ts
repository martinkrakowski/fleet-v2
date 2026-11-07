/** The shared step context and the shared act helpers of AdvanceLaneRunUseCase (AL-1). */
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRefusal, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunFacts } from '../../../domain/lane-run-decider.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome, LaneRunJournalRefusal } from '../../../domain/lane-run-journal.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunParkRequest } from '../../ports/out/LaneRunParkNoticePort.out-port.js';
import type { FindLatestReceiptOfKindResult } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { LaneRunParkFindingView } from '../../../domain/park-findings-view.js';
import { causingParkFindingsView } from '../../../domain/park-findings-view.js';
import { decideConductorReviewOutcome, } from '../../../domain/lane-run-decider.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import { resolveLaneRunProvenance } from '../../../domain/lane-run-records.js';
import { canEnterLaneRunState, workOrderReleaseFor } from '../../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { workOrderHoldFacts } from '../work-order-hold-facts.js';

/** What every advance step reads: the use case's dependencies. Per call, never per run. */
export interface AdvanceStepContext {
  readonly deps: AdvanceLaneRunDependencies;
}

export type WriteOutcome =
  | { readonly ok: true; readonly record?: LaneRunRecord }
  | { readonly ok: false; readonly reason: AdvanceLaneRunRefusal;
      readonly journalRefusal?: LaneRunJournalRefusal; readonly detail?: string | null };

/**
 * A refusal an advance step returns: the coarse port reason plus, when the
 * refusal came from the journal, the journal's typed refusal and its detail.
 */
export interface AdvanceStepRefusal {
  readonly reason: AdvanceLaneRunRefusal;
  readonly journalRefusal?: LaneRunJournalRefusal;
  readonly detail?: string | null;
}

/** Build the port's `refused` result from a step refusal, carrying the journal's reason and detail only when known. */
export function refusedResult(refusal: AdvanceStepRefusal): AdvanceLaneRunResult {
  return {
    outcome: 'refused',
    reason: refusal.reason,
    ...(refusal.journalRefusal !== undefined ? { journalRefusal: refusal.journalRefusal } : {}),
    ...(refusal.detail !== undefined ? { detail: refusal.detail } : {}),
  };
}

/**
 * One advance's facts plus what its decision hooks need. Kept per call, never on
 * the instance: one use case serves overlapping advances of different runs.
 */
export interface GatheredLaneRunFacts {
  readonly facts: LaneRunFacts;
  /** A running attempt's deadline could not be read (K4-4b): park `ambiguous stop`. */
  readonly deadlineUnknown: boolean;
  /** The latest attempt as gathered, for the admission hook. */
  readonly latestAttempt: AttemptRecord | null;
  /** The run's attempt records in `attemptIds` order (null where a record is missing), for the prepare act. */
  readonly attemptRecords: readonly (AttemptRecord | null)[];
}

export async function performEnter(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  from: LaneRunStateValue,
  to: LaneRunStateValue,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const settledOpenPr =
    record.parked !== null &&
    record.parked.reason === 'ambiguous' &&
    record.parked.qualifier === 'open-pr' &&
    record.prNumber !== null;
  if (!canEnterLaneRunState(from, to, record.parked?.parkedFrom ?? null, settledOpenPr, resolveLaneRunProvenance(record))) {
    return { outcome: 'refused', reason: 'illegal-transition' };
  }
  if (to === 'merged' || to === 'stopped') {
    // Before the terminal conduct entry: a crash between the two leaves a
    // non-terminal run the next pass re-ends (the release is idempotent).
    await releaseWorkOrderAtEnd(ctx, record, to, request);
  }
  const appended = await appendConduct(ctx, request, to);
  if (!appended.ok) {
    return refusedResult(appended);
  }
  if (record.parked !== null) {
    const saved = await saveOrRefuse(ctx,
      { ...record, parked: null, revision: record.revision + 1 },
      request,
    );
    if (!saved.ok) {
      return { outcome: 'refused', reason: saved.reason };
    }
  }
  return { outcome: 'entered', state: to };
}

/** The park reasons that also ask one keyed owner question (K6 header). */
const OWNER_QUESTION_REASONS: readonly LaneRunParkReason[] = [
  'one-way-door', 'owner-merge', 'blocker-after-round-2', 'seat-plan-exhausted', 'fix-no-progress',
];

/**
 * Raise the park's attention item and, for the owner reasons, the keyed
 * owner question (K6-7). Everything is failure-tolerant: missing wiring, a
 * missing work order, a refusal or a throw never blocks or changes the park,
 * and the park outcome is returned unchanged. No journal entry is written for
 * the notice (the park key is not a journal key shape); a failed notice leaves
 * `questionId` null for the next park (or the reaper) to re-raise under the
 * same key.
 */
/** The park notice key for one park ordinal: `<runId>/park@<n>`. */
export function parkNoticeKey(runId: string, parkOrdinal: number): string {
  return runId + '/park@' + String(parkOrdinal);
}

/**
 * Re-raise (or raise) the notice of an ALREADY parked record under its saved
 * park ordinal. Failure-tolerant and idempotent like the save path: the ports
 * dedupe by key, so a repeat answers `exists` and costs one call per advance.
 */
export async function raiseParkNotice(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  reason: LaneRunParkReason,
  qualifier: string | null,
  request: AdvanceLaneRunRequest,
): Promise<void> {
  const parkNotice = ctx.deps.parkNotice;
  const workOrderRepo = ctx.deps.workOrderRepo;
  if (parkNotice === undefined || workOrderRepo === undefined) {
    return;
  }
  const key = parkNoticeKey(record.runId, record.parkCount);
  try {
    const workOrder = await workOrderRepo.findWorkOrderById(record.workOrderId);
    if (workOrder === null) {
      return;
    }
    const parkedFindings = record.parked?.findings;
    const parkRequest: LaneRunParkRequest = {
      key,
      projectId: workOrder.projectId,
      workOrderId: record.workOrderId,
      runId: record.runId,
      reason,
      parkCount: record.parkCount,
      ...(qualifier === null ? {} : { qualifier }),
      ...(reason === 'blocker-after-round-2' && parkedFindings !== undefined && parkedFindings !== null && parkedFindings.length > 0
        ? { findings: parkedFindings }
        : {}),
    };
    await parkNotice.recordParkAttention(parkRequest);
    if (OWNER_QUESTION_REASONS.includes(reason)) {
      const asked = await parkNotice.askParkQuestion(parkRequest);
      const questionId = asked.outcome === 'recorded' || asked.outcome === 'exists' ? asked.questionId : undefined;
      if (questionId !== undefined) {
        const current = await ctx.deps.runRepo.get(record.runId);
        if (current !== null && current.parked !== null && current.parked.questionId === null) {
          await saveOrRefuse(ctx,
            {
              ...current,
              parked: { ...current.parked, questionId },
              revision: current.revision + 1,
            },
            request,
          );
        }
      }
    }
  } catch {
    // A notice failure or throw never blocks the park; the park stands as saved.
  }
}

/**
 * KF-36a: release the run's work order at a terminal transition (`merged` or
 * `stopped`), BEFORE the terminal conduct entry is appended. The rule
 * (`workOrderReleaseFor`) reads the reservations itself. Failure-tolerant like
 * `raiseParkNotice`: any throw (a read, the lists, the second save) is caught
 * and swallowed — the run still ends; the work order simply stays claimed (the
 * safe direction), for KF-36b's reconciliation.
 */
export async function releaseWorkOrderAtEnd(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  runEnds: 'merged' | 'stopped',
  request: AdvanceLaneRunRequest,
): Promise<void> {
  const workOrderRelease = ctx.deps.workOrderRelease;
  if (workOrderRelease === undefined) {
    return;
  }
  try {
    const workOrder = await workOrderRelease.findWorkOrderById(record.workOrderId);
    if (workOrder === null) {
      return;
    }
    const holdFacts = await workOrderHoldFacts(ctx.deps,
      record.workOrderId,
      record.attemptIds,
      record.runId,
    );
    const slotHeld = holdFacts.heldAttemptIds.length > 0;
    const otherRunActive = holdFacts.nonTerminalRunIds.length > 0;
    const answer = workOrderReleaseFor({
      runEnds,
      workOrderState: workOrder.state,
      slotHeld,
      otherRunActive,
    });
    if (answer === null) {
      return;
    }
    try {
      await workOrderRelease.saveWorkOrder({
        ...workOrder,
        state: answer,
        revision: workOrder.revision + 1,
        updatedAtIso: request.nowIso,
      });
    } catch {
      // A stale revision: another writer (such as `markMerged`) saved first.
      // Re-read once, re-apply the rule to the fresh record, and save once
      // more if it still answers non-null (the release is idempotent).
      const fresh = await workOrderRelease.findWorkOrderById(record.workOrderId);
      if (fresh === null) {
        return;
      }
      const retry = workOrderReleaseFor({
        runEnds,
        workOrderState: fresh.state,
        slotHeld,
        otherRunActive,
      });
      if (retry === null) {
        return;
      }
      await workOrderRelease.saveWorkOrder({
        ...fresh,
        state: retry,
        revision: fresh.revision + 1,
        updatedAtIso: request.nowIso,
      });
    }
  } catch {
    // Swallowed on purpose (see above): a failed release never blocks the
    // terminal transition; the work order stays claimed and KF-36b's
    // reconciliation closes it later.
  }
}

/**
 * The bounded findings snapshot of a finding-caused park (`blocker-after-
 * round-2` or `acceptance-rejected`), read once at park time and frozen on
 * the parked record (GB2 correction 2, RV3 req (d)). The review kinds are
 * ordered by `parkedFrom` and the attempts are walked newest-first to the
 * latest collected head; the first review receipt whose severity outcome is
 * `failed` supplies the causing blocking findings through
 * `causingParkFindingsView` (guaranteed non-empty when a blocking receipt is
 * found).
 *
 * `null` means the findings could not be read at park time (unwired deps, a
 * missing attempt or head, an `unavailable` receipt lookup, or a read throw):
 * unread stays `null`, never `[]`. `undefined` means every lookup succeeded
 * and no failing review receipt exists at the head (e.g. a gate-caused park):
 * `findings` is omitted, never `[]`. Never throws.
 */
async function blockerFindingsFor(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  parkedFrom: LaneRunStateValue,
): Promise<readonly LaneRunParkFindingView[] | null | undefined> {
  const reviewRequest = ctx.deps.reviewRequest;
  const attemptRepo = ctx.deps.attemptRepo;
  if (reviewRequest === undefined || attemptRepo === undefined) {
    return null;
  }
  // The latest attempt with a collected head, newest first.
  let head: string | undefined;
  let attemptId: string | undefined;
  for (let index = record.attemptIds.length - 1; index >= 0; index -= 1) {
    const id = record.attemptIds[index];
    if (id === undefined) {
      continue;
    }
    try {
      const attempt = await attemptRepo.findAttemptById(id);
      const candidateHead = attempt?.artifacts?.headCommit;
      if (attempt !== null && candidateHead !== undefined) {
        head = candidateHead;
        attemptId = id;
        break;
      }
    } catch {
      return null;
    }
  }
  if (attemptId === undefined || head === undefined) {
    return null;
  }
  const kinds: readonly ('brief-check' | 'code-review' | 'pre-merge')[] =
    parkedFrom === 'brief-check'
      ? ['brief-check', 'code-review', 'pre-merge']
      : parkedFrom === 'awaiting-premerge' || parkedFrom === 'merging'
        ? ['pre-merge', 'code-review', 'brief-check']
        : ['code-review', 'brief-check', 'pre-merge'];
  let sawUnavailableOrThrow = false;
  for (const kind of kinds) {
    let found: FindLatestReceiptOfKindResult;
    try {
      found = await reviewRequest.findLatestReceiptOfKind({ attemptId, candidateHeadSha: head, kind });
    } catch {
      sawUnavailableOrThrow = true;
      continue;
    }
    if (found.outcome === 'unavailable') {
      sawUnavailableOrThrow = true;
      continue;
    }
    if (found.outcome === 'found' && decideConductorReviewOutcome(found.receipt).outcome === 'failed') {
      const caused = causingParkFindingsView(found.receipt.findings);
      return caused.length > 0 ? caused : null;
    }
    // RV3: a `not-found` receipt of a review kind falls back to the latest
    // journal intent's minted request id before the kind is given up.
    if (found.outcome === 'not-found' && (kind === 'code-review' || kind === 'brief-check')) {
      try {
        const entries = await ctx.deps.runJournal.listForRun(record.runId);
        let mintedId: string | null = null;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index]!;
          if (entry.kind !== 'intent' || entry.runId !== record.runId || entry.key === null) {
            continue;
          }
          const parsed = parseLaneRunKey(entry.key);
          if (parsed === null || parsed.kind !== 'step' || parsed.step !== kind) {
            continue;
          }
          mintedId = entry.mintedId;
          break;
        }
        if (mintedId !== null) {
          const byRequest = await reviewRequest.findReviewReceipt({
            attemptId,
            requestId: mintedId,
            candidateHeadSha: head,
          });
          if (
            byRequest.outcome === 'found' &&
            decideConductorReviewOutcome(byRequest.receipt).outcome === 'failed'
          ) {
            const caused = causingParkFindingsView(byRequest.receipt.findings);
            return caused.length > 0 ? caused : null;
          }
          if (byRequest.outcome === 'unavailable') {
            sawUnavailableOrThrow = true;
          }
        }
      } catch {
        sawUnavailableOrThrow = true;
      }
    }
  }
  return sawUnavailableOrThrow ? null : undefined;
}

export async function performPark(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  reason: LaneRunParkReason,
  qualifier: string | null,
  parkedFrom: LaneRunStateValue,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  // RV3 (req d): a park caused by review findings carries the non-empty
  // bounded findings that caused it; `findings: []` is refused at the domain
  // boundary, so only `null` (unread) or a non-empty snapshot is attached,
  // and a park with no failing review receipt omits `findings`.
  const findings =
    reason === 'blocker-after-round-2' || reason === 'acceptance-rejected'
      ? await blockerFindingsFor(ctx, record, parkedFrom)
      : undefined;
  const parkedRecord: LaneRunRecord = {
    ...record,
    parked: {
      reason,
      qualifier,
      parkedFrom,
      questionId: null,
      ...(findings === null || (findings !== undefined && findings.length > 0) ? { findings } : {}),
    },
    parkCount: record.parkCount + 1,
    revision: record.revision + 1,
  };
  const saved = await saveOrRefuse(ctx, parkedRecord, request);
  if (!saved.ok) {
    return { outcome: 'refused', reason: saved.reason };
  }
  const appended = await appendConduct(ctx, request, 'parked');
  if (!appended.ok) {
    return refusedResult(appended);
  }
  await raiseParkNotice(ctx, saved.record ?? parkedRecord, reason, qualifier, request);
  return { outcome: 'parked', reason, qualifier };
}

/** The acts' own cost-ceiling re-check (§3.6): park before anything is written. */
export async function ceilingPark(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult | null> {
  if (!gathered.facts.costCeilingReached) {
    return null;
  }
  return performPark(ctx, record, 'cost-ceiling', null, gathered.facts.state, request);
}

export async function appendRunIntent(ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  key: string,
  mintedId: string | null,
): Promise<AdvanceStepRefusal | null> {
  const appended = await ctx.deps.runJournal.append(
    laneRunIntentEntry(ctx.deps.newUlid(), request.runId, key, mintedId, request.nowIso),
  );
  return appended.outcome === 'appended' ? null
    : { reason: 'journal-refused', journalRefusal: appended.reason, detail: appended.detail };
}

export async function appendRunResult(ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  key: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode | null,
  detail: string | null = null,
): Promise<AdvanceStepRefusal | null> {
  const appended = await ctx.deps.runJournal.append(
    laneRunResultEntry(ctx.deps.newUlid(), request.runId, key, outcome, reasonCode, request.nowIso, detail),
  );
  return appended.outcome === 'appended' ? null
    : { reason: 'journal-refused', journalRefusal: appended.reason, detail: appended.detail };
}

/** The minted id of a key's intent, or null when the key has no intent. */
export async function intentMintedIdOf(ctx: AdvanceStepContext, key: string): Promise<string | null> {
  const entries = await ctx.deps.runJournal.listForKey(key);
  for (const entry of entries) {
    if (entry.kind === 'intent') {
      return entry.mintedId;
    }
  }
  return null;
}

export async function appendConduct(ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  state: LaneRunStateValue,
): Promise<WriteOutcome> {
  const appended = await ctx.deps.runJournal.append(
    laneRunConductEntry(ctx.deps.newUlid(), request.runId, state, request.nowIso),
  );
  return appended.outcome === 'appended' ? { ok: true }
    : { ok: false, reason: 'journal-refused', journalRefusal: appended.reason, detail: appended.detail };
}

export async function saveOrRefuse(ctx: AdvanceStepContext, next: LaneRunRecord, request: AdvanceLaneRunRequest): Promise<WriteOutcome> {
  const saved = await ctx.deps.runRepo.save(next, {
    holderId: request.lease.holderId,
    fence: request.lease.fence,
    nowIso: request.nowIso,
  });
  return saved.outcome === 'saved' ? { ok: true, record: saved.record } : { ok: false, reason: 'save-refused' };
}
