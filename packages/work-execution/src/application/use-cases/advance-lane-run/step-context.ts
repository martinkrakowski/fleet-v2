/** The shared step context and the shared act helpers of AdvanceLaneRunUseCase (AL-1). */
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRefusal, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunFacts } from '../../../domain/lane-run-decider.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { canEnterLaneRunState } from '../../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';

/** What every advance step reads: the use case's dependencies. Per call, never per run. */
export interface AdvanceStepContext {
  readonly deps: AdvanceLaneRunDependencies;
}

export type WriteOutcome =
  | { readonly ok: true; readonly record?: LaneRunRecord }
  | { readonly ok: false; readonly reason: AdvanceLaneRunRefusal };

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
  if (!canEnterLaneRunState(from, to, record.parked?.parkedFrom ?? null)) {
    return { outcome: 'refused', reason: 'illegal-transition' };
  }
  const appended = await appendConduct(ctx, request, to);
  if (!appended.ok) {
    return { outcome: 'refused', reason: appended.reason };
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

export async function performPark(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  reason: LaneRunParkReason,
  qualifier: string | null,
  parkedFrom: LaneRunStateValue,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const saved = await saveOrRefuse(ctx,
    {
      ...record,
      parked: { reason, qualifier, parkedFrom, questionId: null },
      parkCount: record.parkCount + 1,
      revision: record.revision + 1,
    },
    request,
  );
  if (!saved.ok) {
    return { outcome: 'refused', reason: saved.reason };
  }
  const appended = await appendConduct(ctx, request, 'parked');
  if (!appended.ok) {
    return { outcome: 'refused', reason: appended.reason };
  }
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
): Promise<AdvanceLaneRunRefusal | null> {
  const appended = await ctx.deps.runJournal.append(
    laneRunIntentEntry(ctx.deps.newUlid(), request.runId, key, mintedId, request.nowIso),
  );
  return appended.outcome === 'appended' ? null : 'journal-refused';
}

export async function appendRunResult(ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  key: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode | null,
): Promise<AdvanceLaneRunRefusal | null> {
  const appended = await ctx.deps.runJournal.append(
    laneRunResultEntry(ctx.deps.newUlid(), request.runId, key, outcome, reasonCode, request.nowIso),
  );
  return appended.outcome === 'appended' ? null : 'journal-refused';
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
  return appended.outcome === 'appended' ? { ok: true } : { ok: false, reason: 'journal-refused' };
}

export async function saveOrRefuse(ctx: AdvanceStepContext, next: LaneRunRecord, request: AdvanceLaneRunRequest): Promise<WriteOutcome> {
  const saved = await ctx.deps.runRepo.save(next, {
    holderId: request.lease.holderId,
    fence: request.lease.fence,
    nowIso: request.nowIso,
  });
  return saved.outcome === 'saved' ? { ok: true, record: saved.record } : { ok: false, reason: 'save-refused' };
}
