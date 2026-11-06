/**
 * KS7b: the conducted run's merge hand-off. `act merge-enqueue` replaces the one-way
 * `act merge`: it enqueues the run's PR head on the daemon's merge queue (`EnqueueMergePort`)
 * and waits there. One run-journal key per round and head
 * `<runId>/r<round>/merge-enqueue@<head12>`; the intent's minted id is the queue entry id, so a
 * crash between the intent and the enqueue is recovered by the reconcile, which enqueues the
 * same entry id again (the queue answers a duplicate with the first entry). The step is
 * two-way: a queued entry appends no result and the run waits; the reconcile reads the entry
 * through `MergeQueueRepositoryPort.listMergeEntries` on every advance and journals only a final answer (merged,
 * dropped, held). An unreadable, absent-after-retry or unrecognised queue state is a wait,
 * never a merge. Only reason tokens from closed sets are journalled; the queue's free text,
 * paths and ids are never echoed.
 */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { MergeQueueEnqueueCommand } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import { head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { MERGE_DROP_REASONS } from '../../../domain/merge-queue-records.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, intentMintedIdOf, refusedResult } from './step-context.js';

type ActDecision = Extract<LaneRunDecision, { kind: 'act' }>;
type ReconcileDecision = Extract<LaneRunDecision, { kind: 'reconcile' }>;

const HEX_40_PATTERN = /^[0-9a-f]{40}$/;
/** How long one queue call may take, from the advance's own clock. */
const QUEUE_CALL_BUDGET_MS = 60_000;
/** The only refusal tokens the journal takes from the enqueue port. */
const ENQUEUE_REFUSAL_TOKENS: readonly string[] = [
  'invalid-head', 'invalid-repository', 'invalid-entry-id', 'invalid-tier', 'invalid-enqueued-at', 'invalid-deadline',
];

const WAIT: AdvanceLaneRunResult = { outcome: 'waiting', reason: 'merge-train' };
const WAIT_INCONSISTENT: AdvanceLaneRunResult = { outcome: 'waiting', reason: 'facts-inconsistent' };

/** What the step needs of one queue entry; everything else is ignored. */
interface QueueEntryView {
  readonly entryId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly supersedes: string | null;
  readonly headOid: string;
  readonly runId: string | null;
}

const TERMINAL_STATES: readonly string[] = ['merged', 'dropped', 'superseded'];

/** The entry fields this step reads, or null for an entry of the wrong shape. Never throws. */
function viewOfEntry(raw: unknown, repository: { readonly owner: string; readonly repo: string }, pullRequest: number): QueueEntryView | null {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    const repo = entry.repository as Record<string, unknown> | null | undefined;
    if (
      typeof repo !== 'object' || repo === null ||
      repo.owner !== repository.owner || repo.repo !== repository.repo ||
      entry.pullRequest !== pullRequest ||
      typeof entry.entryId !== 'string' || typeof entry.state !== 'string' ||
      typeof entry.headOid !== 'string' ||
      (entry.reason !== null && typeof entry.reason !== 'string') ||
      (entry.supersedes !== null && typeof entry.supersedes !== 'string') ||
      (entry.runId !== null && typeof entry.runId !== 'string')
    ) {
      return null;
    }
    return {
      entryId: entry.entryId,
      state: entry.state,
      reason: entry.reason as string | null,
      supersedes: entry.supersedes as string | null,
      headOid: entry.headOid,
      runId: entry.runId as string | null,
    };
  } catch {
    return null;
  }
}

/**
 * The run's entry: the one the intent minted (at this head, enqueued by this run), else the live entry at the run's head (a
 * duplicate someone else enqueued), then followed along its `supersedes` successors to the
 * tip. Null when the queue holds neither. Total; the walk is bounded and cycle-safe.
 */
function tipOfRunEntry(views: readonly QueueEntryView[], mintedId: string, headSha: string, runId: string): QueueEntryView | null {
  // The minted entry counts only when it is this run's own at this head: a row that carries the id but
  // another head or run is stale or foreign and is never followed.
  let current: QueueEntryView | undefined =
    views.find((view) => view.entryId === mintedId && view.headOid === headSha && view.runId === runId) ??
    views.find((view) => view.headOid === headSha && !TERMINAL_STATES.includes(view.state));
  if (current === undefined) {
    return null;
  }
  const seen = new Set<string>([current.entryId]);
  for (let step = 0; step < views.length; step += 1) {
    const from: QueueEntryView = current;
    const next = views.find((view) => view.supersedes === from.entryId && !seen.has(view.entryId));
    if (next === undefined) {
      break;
    }
    seen.add(next.entryId);
    current = next;
  }
  return current;
}

/** The queue's final answer as a journal result, or null while the entry is still the queue's to work. */
function finalAnswerOf(tip: QueueEntryView): {
  readonly reasonCode: LaneRunResultReasonCode;
  readonly detail: string | null;
} | null {
  if (tip.state === 'merged') {
    return { reasonCode: 'merged', detail: null };
  }
  if (tip.state === 'dropped') {
    const reason = tip.reason;
    const known = reason !== null && (MERGE_DROP_REASONS as readonly string[]).includes(reason);
    return { reasonCode: 'merge-dropped', detail: known ? reason : 'unknown' };
  }
  if (tip.state === 'parked' && tip.reason === 'veto-hold') {
    return { reasonCode: 'merge-held', detail: 'veto-hold' };
  }
  return null;
}

async function appendFinal(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ActDecision | ReconcileDecision,
  outcome: 'completed' | 'refused' | 'overtaken',
  reasonCode: LaneRunResultReasonCode,
  detail: string | null,
): Promise<AdvanceLaneRunResult> {
  const refusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode, detail);
  if (refusal !== null) {
    return refusedResult(refusal);
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode, detail };
}

/** The deadline of a queue call, from the advance clock; null when that clock does not parse. */
function deadlineOf(nowIso: string): string | null {
  const now = Date.parse(nowIso);
  return Number.isFinite(now) ? new Date(now + QUEUE_CALL_BUDGET_MS).toISOString() : null;
}

interface EnqueueInputs {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequest: number;
  readonly headSha: string;
  readonly deadlineIso: string;
}

/** What the step reads of the run before it touches the queue; a wait result when a fact is missing. */
function inputsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  request: AdvanceLaneRunRequest,
  head12: string | null,
): EnqueueInputs | AdvanceLaneRunResult {
  const latest = gathered.latestAttempt;
  const repository = ctx.deps.forgeRepository;
  if (latest === null || latest.artifacts === null || repository === undefined || record.prNumber === null) {
    return WAIT_INCONSISTENT;
  }
  const headSha = latest.artifacts.headCommit;
  if (!HEX_40_PATTERN.test(headSha) || head12Of(headSha) !== head12) {
    return WAIT_INCONSISTENT;
  }
  const deadlineIso = deadlineOf(request.nowIso);
  if (deadlineIso === null) {
    return WAIT_INCONSISTENT;
  }
  return { repository, pullRequest: record.prNumber, headSha, deadlineIso };
}

function isInputs(value: EnqueueInputs | AdvanceLaneRunResult): value is EnqueueInputs {
  return 'headSha' in value;
}

/**
 * Enqueue the run's head under the minted entry id and report the result: a refusal is a final
 * refused result; a created, duplicate or superseding answer, a throw or an answer of any other
 * shape leaves the intent open (the queue holds the entry, or the reconcile asks again).
 */
async function enqueueEntry(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  decision: ActDecision | ReconcileDecision,
  request: AdvanceLaneRunRequest,
  inputs: EnqueueInputs,
  entryId: string,
): Promise<AdvanceLaneRunResult> {
  const enqueueMerge = ctx.deps.enqueueMerge;
  if (enqueueMerge === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const command: MergeQueueEnqueueCommand = {
    repository: inputs.repository,
    pullRequest: inputs.pullRequest,
    headOid: inputs.headSha,
    tier: record.tier,
    enqueuedBy: 'conductor',
    runId: record.runId,
    entryId,
    successorEntryId: ctx.deps.newUlid(),
    enqueuedAtIso: request.nowIso,
    deadlineIso: inputs.deadlineIso,
  };
  let answer: Awaited<ReturnType<typeof enqueueMerge.enqueue>>;
  try {
    answer = await enqueueMerge.enqueue(command);
  } catch {
    return WAIT;
  }
  let refusalToken: string | null = null;
  try {
    if (typeof answer === 'object' && answer !== null && answer.outcome === 'refused') {
      refusalToken = typeof answer.reason === 'string' && ENQUEUE_REFUSAL_TOKENS.includes(answer.reason) ? answer.reason : 'unknown';
    }
  } catch {
    return WAIT;
  }
  if (refusalToken !== null) {
    return appendFinal(ctx, request, decision, 'refused', 'merge-enqueue-refused', refusalToken);
  }
  return WAIT;
}

/**
 * The `act merge-enqueue` step: one keyed intent whose minted id is the queue entry id, then
 * the enqueue. A spent key (an intent already journalled) is never written again: the
 * reconcile owns it.
 */
export async function performMergeEnqueue(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  if (ctx.deps.enqueueMerge === undefined || ctx.deps.mergeQueue === undefined || ctx.deps.forgeRepository === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const inputs = inputsOf(ctx, record, gathered, request, decision.head12);
  if (!isInputs(inputs)) {
    return inputs;
  }
  const entries = await ctx.deps.runJournal.listForKey(decision.key);
  if (entries.some((entry) => entry.kind === 'intent')) {
    return WAIT;
  }
  const entryId = ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, entryId);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  return enqueueEntry(ctx, record, decision, request, inputs, entryId);
}

/**
 * The merge-enqueue reconcile: an open intent is settled by reading the queue, never by
 * starting over. A moved head or round is `overtaken`. The entry is found by the minted id (or
 * by the live entry at the head) and followed to its tip: merged, dropped and veto-hold are
 * journalled as the final answer; every other state, an unreadable queue and an unrecognised
 * answer wait. An entry the queue does not hold is enqueued again under the same id.
 */
export async function reconcileMergeEnqueue(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const parsed = parseLaneRunKey(decision.key);
  if (
    parsed === null || parsed.kind !== 'merge-enqueue' ||
    parsed.head12 !== gathered.facts.head12 || parsed.round !== record.round
  ) {
    return appendFinal(ctx, request, decision, 'overtaken', 'merge-overtaken', null);
  }
  if (ctx.deps.enqueueMerge === undefined || ctx.deps.mergeQueue === undefined || ctx.deps.forgeRepository === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const inputs = inputsOf(ctx, record, gathered, request, parsed.head12);
  if (!isInputs(inputs)) {
    return inputs;
  }
  const mintedId = await intentMintedIdOf(ctx, decision.key);
  if (mintedId === null) {
    return appendFinal(ctx, request, decision, 'refused', 'merge-enqueue-refused', 'invalid-entry-id');
  }
  let rawEntries: unknown;
  try {
    rawEntries = await ctx.deps.mergeQueue.listMergeEntries({ repository: inputs.repository, deadlineIso: inputs.deadlineIso });
  } catch {
    return WAIT;
  }
  if (!Array.isArray(rawEntries)) {
    return WAIT;
  }
  const views: QueueEntryView[] = [];
  for (const raw of rawEntries as readonly unknown[]) {
    const view = viewOfEntry(raw, inputs.repository, inputs.pullRequest);
    if (view !== null) {
      views.push(view);
    }
  }
  const tip = tipOfRunEntry(views, mintedId, inputs.headSha, record.runId);
  if (tip === null) {
    return enqueueEntry(ctx, record, decision, request, inputs, mintedId);
  }
  const final = finalAnswerOf(tip);
  if (final === null) {
    return WAIT;
  }
  return appendFinal(ctx, request, decision, 'completed', final.reasonCode, final.detail);
}
