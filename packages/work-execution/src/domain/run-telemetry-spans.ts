/**
 * The pure mapper of the run-telemetry traces (plan §3.1, §3.3, §3.4;
 * OT1b-1, OT1b-2): `laneRunSpans(hmac, facts)` maps a `LaneRunRecord`, its
 * keyed journal and its attempts to closed `TelemetrySpan`s only — the root
 * when the run is terminal, round spans once closed, one span per keyed step
 * (intent → final result), the stop request, one ci-wait span per closed
 * watching-ci conduct entry, the attempt and usage spans under their rounds,
 * and `attemptTraceSpans(hmac, facts)` maps a hand-run attempt's trace. Never
 * throws, never reads a clock: every time comes from a record field, every id
 * from the §3.4 identity functions. A span whose identity, ids or digest
 * cannot be built is dropped and counted in `rejectedInvalid`, never emitted
 * half-built.
 */

import { billingOf } from '@fleet/shared';
import { parseLaneRunKey, stopModeOfKey, type ParsedLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_TERMINAL_STATES } from './value-objects/LaneRunState.vo.js';
import { CAPACITY_RELEASE_STATES } from './value-objects/AttemptState.vo.js';
import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { LANE_RUN_MAX_ROUND, type LaneRunKeyStep, type LaneRunRecord } from './lane-run-records.js';
import type { AttemptRecord, AttemptUsageRecord } from './execution-records.js';
import {
  attemptIdentity,
  attemptTraceRoot,
  ciWaitIdentity,
  journalKeyIdentity,
  reviewReceiptIdentity,
  roundIdentity,
  runRootIdentity,
  runTraceRoot,
  telemetryDigest,
  telemetryHashInput,
  telemetrySpanId,
  telemetryTraceId,
  usageIdentity,
  verificationReceiptIdentity,
  type TelemetryDigestKind,
  type TelemetryHmac,
  type TelemetryHashInput,
  type TelemetrySpanIdentity,
  type TelemetryTraceRoot,
} from './run-telemetry-ids.js';
import { TELEMETRY_MAX_EVENTS, TelemetrySpan } from './run-telemetry.js';
import type { TelemetrySpanEvent, TelemetrySpanName, TelemetrySpanStatus } from './run-telemetry.js';
import type { TelemetrySpanKind } from './run-telemetry-attributes.js';

/** The plain input facts of the run mapper (plan §3.3): no raw id leaves it. */
export interface LaneRunTelemetryFacts {
  readonly run: LaneRunRecord;
  readonly journal: readonly LaneRunJournalEntryRecord[];
  /** The project alias, if any (policy.telemetry.projectAliases). */
  readonly project: string | null;
  readonly tags: readonly string[];
  /** The run's attempts (plan §3.1): their attempt and usage spans hang under the round of their dispatch key. */
  readonly attempts: readonly AttemptRecord[];
}

/** The mirror of the application's receipt projection (plan §3.1): the domain never imports an application port. */
export type TelemetryReceiptResult = 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type TelemetryReviewReceiptKind = 'brief-check' | 'code-review' | 'pre-merge';

export interface TelemetryGateReceiptFact {
  readonly receiptId: TelemetryHashInput;
  readonly result: TelemetryReceiptResult;
  readonly exitCode: number | null;
  readonly completedAtIso: string;
}

export interface TelemetryReviewReceiptFact {
  readonly receiptId: TelemetryHashInput;
  readonly kind: TelemetryReviewReceiptKind;
  readonly result: TelemetryReceiptResult;
  readonly findings: { readonly blocker: number; readonly major: number; readonly minor: number; readonly nit: number };
  readonly completedAtIso: string;
}

export interface TelemetryReceiptFacts {
  readonly verification: readonly TelemetryGateReceiptFact[];
  readonly review: readonly TelemetryReviewReceiptFact[];
}

/** The plain input facts of the hand-run mapper (plan §3.1, §3.4): no raw id leaves it. */
export interface AttemptTraceTelemetryFacts {
  readonly attempt: AttemptRecord;
  readonly receipts: TelemetryReceiptFacts;
  /** Conducted attempt ids: an attempt that belongs to a run is never exported as a hand-run trace. */
  readonly conductedAttemptIds: ReadonlySet<string>;
}

/** The mapper's result: only closed spans, plus the dropped-and-counted ones. */
export interface LaneRunSpansResult {
  readonly spans: readonly TelemetrySpan[];
  readonly rejectedInvalid: number;
}

/** The span kind of each keyed step (plan §3.1). */
const STEP_SPAN_KINDS: Readonly<Record<LaneRunKeyStep, TelemetrySpanKind>> = Object.freeze({
  prepare: 'CHAIN',
  dispatch: 'CHAIN',
  stop: 'CHAIN',
  collect: 'CHAIN',
  reconcile: 'CHAIN',
  gate: 'GUARDRAIL',
  'brief-check': 'EVALUATOR',
  'code-review': 'EVALUATOR',
  'pre-merge': 'EVALUATOR',
  accept: 'DECISION',
  park: 'DECISION',
  'open-pr': 'TOOL',
  push: 'TOOL',
  merge: 'TOOL',
  premerge: 'TOOL',
});

/** The steps whose span hangs under the round span; the rest hang under the root (plan §3.1). */
const ROUND_STEPS: readonly LaneRunKeyStep[] = [
  'prepare', 'dispatch', 'collect', 'reconcile', 'stop', 'gate', 'brief-check', 'code-review', 'pre-merge',
];

/** The states in which an attempt is terminal and its spans may be emitted (plan §3.1). */
const TERMINAL_ATTEMPT_STATES: readonly string[] = CAPACITY_RELEASE_STATES;

/** A span identity and its build input, once both are known. */
interface PendingSpan {
  readonly identity: TelemetrySpanIdentity;
  readonly name: TelemetrySpanName;
  readonly kind: TelemetrySpanKind;
  readonly startIso: string;
  readonly endIso: string;
  readonly status: TelemetrySpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly parentSpanId: string | null;
  readonly events: readonly TelemetrySpanEvent[];
}

/** One keyed journal group: its first intent, its final results, its ambiguous count. */
interface KeyGroup {
  readonly key: string;
  intent: LaneRunJournalEntryRecord | null;
  readonly results: LaneRunJournalEntryRecord[];
  ambiguous: number;
}

/** A round's aggregate start, end and errored status, updated from built step spans. */
interface RoundSpanInfo {
  startIso: string;
  endIso: string;
  errored: TelemetrySpanStatus | null;
}

/** The final (non-`ambiguous`) result of a key's results: the last one, or null. */
function finalResultOf(results: readonly LaneRunJournalEntryRecord[]): LaneRunJournalEntryRecord | null {
  let final: LaneRunJournalEntryRecord | null = null;
  for (const entry of results) {
    if (entry.outcome !== 'ambiguous') {
      final = entry;
    }
  }
  return final;
}

/** A final result's status: `ok` for `completed`, `error` with its reason code otherwise (plan §3.1). */
function statusOfResult(result: LaneRunJournalEntryRecord): TelemetrySpanStatus {
  if (result.outcome === 'completed') {
    return { code: 'ok', reasonCode: null };
  }
  return { code: 'error', reasonCode: result.reasonCode };
}

/** A `<kind>` digest of an id: null when either wrapping or digesting fails. */
function digestOf(hmac: TelemetryHmac, kind: TelemetryDigestKind, id: string): string | null {
  const input = telemetryHashInput(id);
  if (input === null) {
    return null;
  }
  return telemetryDigest(hmac, kind, input);
}

/** The candidate attributes of an attempt span (both trace kinds); validated by `TelemetrySpan.build`. */
function attemptAttributes(hmac: TelemetryHmac, attempt: AttemptRecord, sessionDigest: string): Readonly<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {
    'session.id': sessionDigest,
    'fleet.attempt.kind': attempt.kind,
    'fleet.fix_number': attempt.fixNumber,
  };
  const attemptDigest = digestOf(hmac, 'attempt', attempt.id);
  if (attemptDigest !== null) {
    attributes['fleet.attempt.digest'] = attemptDigest;
  }
  const priorDigest = attempt.priorAttemptId === null ? null : digestOf(hmac, 'attempt', attempt.priorAttemptId);
  if (priorDigest !== null) {
    attributes['fleet.prior_attempt.digest'] = priorDigest;
  }
  const seat = attempt.seatSelection;
  if (seat !== null && seat !== undefined) {
    attributes['agent.name'] = seat.role;
    attributes['fleet.seat.model'] = seat.model;
    if (seat.tool !== null) {
      attributes['fleet.seat.tool'] = seat.tool;
    }
  }
  attributes['fleet.seat.billing'] = billingOf(attempt.runner?.kind ?? attempt.seatSelection?.tool);
  if (attempt.outcome !== null) {
    attributes['fleet.outcome'] = attempt.outcome;
  }
  if (attempt.stopReason !== undefined && attempt.stopReason !== null) {
    attributes['fleet.stop_reason'] = attempt.stopReason;
  }
  return attributes;
}

/** The candidate attributes of an attempt's usage LLM span (plan §3.1, §3.6); validated by `TelemetrySpan.build`. */
function usageAttributes(attempt: AttemptRecord, usage: AttemptUsageRecord): Readonly<Record<string, unknown>> {
  const billing = billingOf(attempt.runner?.kind ?? attempt.seatSelection?.tool);
  const attributes: Record<string, unknown> = {
    'fleet.usage.steps': usage.steps,
    'fleet.usage.wall_seconds': usage.wallSeconds,
    'fleet.usage.source': usage.source,
    'fleet.seat.billing': billing,
  };
  if (usage.tokensInput !== null) {
    attributes['llm.token_count.prompt'] = usage.tokensInput;
  }
  if (usage.tokensOutput !== null) {
    attributes['llm.token_count.completion'] = usage.tokensOutput;
  }
  if (usage.tokensReasoning !== null) {
    attributes['llm.token_count.completion_details.reasoning'] = usage.tokensReasoning;
  }
  if (usage.tokensCacheRead !== null) {
    attributes['llm.token_count.prompt_details.cache_read'] = usage.tokensCacheRead;
  }
  if (usage.tokensCacheWrite !== null) {
    attributes['llm.token_count.prompt_details.cache_write'] = usage.tokensCacheWrite;
  }
  if (billing === 'metered') {
    if (usage.model !== null) {
      attributes['llm.model_name'] = usage.model;
    }
    if (usage.costUsd !== null) {
      attributes['llm.cost.total'] = usage.costUsd;
    }
  } else if (usage.costUsd !== null) {
    attributes['fleet.cost.estimate_usd'] = usage.costUsd;
    attributes['fleet.cost.basis'] = billing === 'plan' ? 'plan-estimate' : 'unknown';
  }
  return attributes;
}

/** A shared span accumulator: the emitted spans, the rejected counter and the builder. */
interface SpanBuilder {
  readonly spans: TelemetrySpan[];
  readonly rejected: { count: number };
  build(span: PendingSpan): TelemetrySpan | null;
}

/**
 * A span builder for one trace: an id, parent or build failure drops the span
 * and counts it in `rejected`; a non-root span is never emitted without a
 * parent span id. `rootSpanName` names the trace's root span.
 */
function createSpanBuilder(
  hmac: TelemetryHmac,
  root: TelemetryTraceRoot,
  traceId: string,
  rootSpanName: TelemetrySpanName,
): SpanBuilder {
  const spans: TelemetrySpan[] = [];
  const rejected = { count: 0 };
  const build = (span: PendingSpan): TelemetrySpan | null => {
    const spanId = telemetrySpanId(hmac, root, span.identity);
    if (spanId === null) {
      rejected.count += 1;
      return null;
    }
    if (span.parentSpanId === null && span.name !== rootSpanName) {
      rejected.count += 1;
      return null;
    }
    const built = TelemetrySpan.build({
      traceId,
      spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startIso: span.startIso,
      endIso: span.endIso,
      status: span.status,
      attributes: span.attributes,
      events: span.events,
    });
    if (built === null) {
      rejected.count += 1;
      return null;
    }
    spans.push(built);
    return built;
  };
  return { spans, rejected, build };
}

/** The context every run-mapper helper shares: ids, shared attributes and the rejected counter. */
interface RunMapperContext {
  readonly hmac: TelemetryHmac;
  readonly root: TelemetryTraceRoot;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly sharedAttributes: Readonly<Record<string, unknown>>;
  readonly rejected: { count: number };
}

/** The journal scoped to the run (plan §3.1): step and stop keys of this run, and its conduct entries with a state. */
function scopeJournal(facts: LaneRunTelemetryFacts): LaneRunJournalEntryRecord[] {
  const runId = facts.run.runId;
  return facts.journal.filter((entry) => {
    if (entry.kind === 'conduct') {
      return entry.runId === runId && entry.state !== null;
    }
    if (entry.kind !== 'intent' && entry.kind !== 'result') {
      return false;
    }
    if (entry.key === null) {
      return false;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || (parsed.kind !== 'step' && parsed.kind !== 'stop')) {
      return false;
    }
    return parsed.runId === runId;
  });
}

/** The keyed journal: one group per key, intents and results in journal order. */
function groupStepEntries(journal: readonly LaneRunJournalEntryRecord[]): KeyGroup[] {
  const groups: KeyGroup[] = [];
  const byKey = new Map<string, KeyGroup>();
  for (const entry of journal) {
    if ((entry.kind !== 'intent' && entry.kind !== 'result') || entry.key === null) {
      continue;
    }
    let group = byKey.get(entry.key);
    if (group === undefined) {
      group = { key: entry.key, intent: null, results: [], ambiguous: 0 };
      byKey.set(entry.key, group);
      groups.push(group);
    }
    if (entry.kind === 'intent') {
      // A key carries one intent; a second one (which the journal refuses)
      // never replaces the first, so a prefix and the full journal agree.
      group.intent ??= entry;
    } else if (entry.outcome === 'ambiguous') {
      group.ambiguous += 1;
    } else {
      group.results.push(entry);
    }
  }
  return groups;
}

/** The rounds an intent has started, and the highest started round (plan §3.1). */
function roundStartInfo(journal: readonly LaneRunJournalEntryRecord[]): {
  roundsStarted: Set<number>;
  maxRoundStarted: number;
} {
  const roundsStarted = new Set<number>();
  for (const entry of journal) {
    if (entry.kind !== 'intent' || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed !== null && parsed.kind === 'step') {
      roundsStarted.add(parsed.round);
    }
  }
  const maxRoundStarted = roundsStarted.size > 0 ? Math.max(...roundsStarted) : -1;
  return { roundsStarted, maxRoundStarted };
}

/** The run's conduct entries, in journal order. */
function conductEntries(journal: readonly LaneRunJournalEntryRecord[]): readonly LaneRunJournalEntryRecord[] {
  return journal.filter((entry) => entry.kind === 'conduct');
}

/** Whether the last conduct entry closes the run terminally (plan §3.1). */
function isTerminal(lastConduct: LaneRunJournalEntryRecord | null): boolean {
  const lastState = lastConduct?.state ?? null;
  return lastState !== null && (LANE_RUN_TERMINAL_STATES as readonly string[]).includes(lastState);
}

/** The dispatch-key group whose intent minted the attempt, with its round and seat. */
function findDispatchGroup(
  groups: readonly KeyGroup[],
  attemptId: string,
): { group: KeyGroup; round: number; seatIndex: number } | null {
  for (const group of groups) {
    const parsed = parseLaneRunKey(group.key);
    if (parsed?.kind !== 'step' || parsed?.step !== 'dispatch') {
      continue;
    }
    if (group.intent?.mintedId === attemptId) {
      return { group, round: parsed.round, seatIndex: parsed.seatIndex };
    }
  }
  return null;
}

/** The collect-key group of the same (round, seat). */
function findCollectGroup(groups: readonly KeyGroup[], round: number, seatIndex: number): KeyGroup | null {
  for (const group of groups) {
    const parsed = parseLaneRunKey(group.key);
    if (parsed?.kind !== 'step' || parsed?.step !== 'collect') {
      continue;
    }
    if (parsed.round === round && parsed.seatIndex === seatIndex) {
      return group;
    }
  }
  return null;
}

/** Fold a built step span's window into the round's aggregate. */
function updateRoundInfo(
  roundOf: Map<number, RoundSpanInfo>,
  round: number,
  startIso: string,
  endIso: string,
  status: TelemetrySpanStatus,
): void {
  const current = roundOf.get(round);
  if (current === undefined) {
    roundOf.set(round, {
      startIso,
      endIso,
      errored: status.code === 'error' ? status : null,
    });
    return;
  }
  if (Date.parse(startIso) < Date.parse(current.startIso)) {
    current.startIso = startIso;
  }
  if (Date.parse(endIso) > Date.parse(current.endIso)) {
    current.endIso = endIso;
  }
  if (status.code === 'error') {
    current.errored = status;
  }
}

/** Build one keyed step span, updating the round aggregate; `parsed` is a known step key. */
function buildStepSpan(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  group: KeyGroup,
  intent: LaneRunJournalEntryRecord,
  parsed: Extract<ParsedLaneRunKey, { kind: 'step' }>,
  roundOf: Map<number, RoundSpanInfo>,
  pendingStepRounds: Set<number>,
): void {
  const hashInput = telemetryHashInput(group.key);
  if (hashInput === null) {
    ctx.rejected.count += 1;
    return;
  }
  // A premerge step key never builds a step span: it parses as kind
  // 'premerge' (never kind 'step'), so this guard is unreachable at runtime
  // and only keeps the span name within the fixed span-name union.
  if (parsed.step === 'premerge') {
    return;
  }
  const final = finalResultOf(group.results);
  const underRound = ROUND_STEPS.includes(parsed.step);
  if (final === null) {
    // Only a round-parented step holds its round open: an unfinalized
    // root-parented key (accept, open-pr, push, merge, park) can never
    // withhold a completed round span.
    if (underRound) {
      pendingStepRounds.add(parsed.round);
    }
    return;
  }
  const identity = journalKeyIdentity(hashInput);
  if (identity === null) {
    ctx.rejected.count += 1;
    return;
  }
  const attributes: Record<string, unknown> = {
    'fleet.step': parsed.step,
    'fleet.round': parsed.round,
    ...ctx.sharedAttributes,
  };
  if (final.reasonCode !== null) {
    attributes['fleet.reason_code'] = final.reasonCode;
  }
  if (group.ambiguous > 0) {
    attributes['fleet.ambiguous_results'] = group.ambiguous;
  }
  const status = statusOfResult(final);
  let parentSpanId: string | null = ctx.rootSpanId;
  if (underRound) {
    const roundIdentityOf = roundIdentity(parsed.round);
    if (roundIdentityOf === null) {
      ctx.rejected.count += 1;
      return;
    }
    parentSpanId = telemetrySpanId(ctx.hmac, ctx.root, roundIdentityOf);
  }
  const built = builder.build({
    identity,
    name: parsed.step,
    kind: STEP_SPAN_KINDS[parsed.step],
    startIso: intent.recordedAtIso,
    endIso: final.recordedAtIso,
    status,
    attributes,
    parentSpanId,
    events: [],
  });
  if (built === null || !underRound) {
    return;
  }
  updateRoundInfo(roundOf, parsed.round, intent.recordedAtIso, final.recordedAtIso, status);
}

/** The step-span build result: the round aggregates and the rounds held open by unfinalized round steps. */
interface StepSpanBuildResult {
  readonly roundOf: Map<number, RoundSpanInfo>;
  readonly pendingStepRounds: ReadonlySet<number>;
}

/** Build every keyed step span; stop requests are collected separately. */
function buildStepSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  groups: readonly KeyGroup[],
): StepSpanBuildResult {
  const roundOf = new Map<number, RoundSpanInfo>();
  const pendingStepRounds = new Set<number>();
  for (const group of groups) {
    const parsed = parseLaneRunKey(group.key);
    if (parsed?.kind !== 'step' || group.intent === null) {
      continue;
    }
    const intent = group.intent;
    buildStepSpan(ctx, builder, group, intent, parsed, roundOf, pendingStepRounds);
  }
  return { roundOf, pendingStepRounds };
}

/** The root span, only when the run is terminal (D2). */
function buildRootSpan(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  facts: LaneRunTelemetryFacts,
  journal: readonly LaneRunJournalEntryRecord[],
  conduct: readonly LaneRunJournalEntryRecord[],
  lastConduct: LaneRunJournalEntryRecord | null,
  terminal: boolean,
): void {
  if (lastConduct === null || lastConduct.state === null || !terminal || journal.length === 0) {
    return;
  }
  const lastState = lastConduct.state;
  const allEvents: TelemetrySpanEvent[] = [];
  for (const entry of conduct) {
    if (entry.state === null) {
      continue;
    }
    allEvents.push({ name: 'state.entered', timeIso: entry.recordedAtIso, state: entry.state });
  }
  const events =
    allEvents.length > TELEMETRY_MAX_EVENTS
      ? allEvents.slice(-TELEMETRY_MAX_EVENTS)
      : allEvents;
  const attributes: Record<string, unknown> = {
    'fleet.run.id': facts.run.runId,
    'fleet.tier': facts.run.tier,
    ...ctx.sharedAttributes,
  };
  if (facts.tags.length > 0) {
    attributes['tag.tags'] = facts.tags.slice();
  }
  if (facts.project !== null) {
    attributes['fleet.project'] = facts.project;
  }
  builder.build({
    identity: runRootIdentity(),
    name: 'lane-run',
    kind: 'CHAIN',
    startIso: journal[0].recordedAtIso,
    endIso: lastConduct.recordedAtIso,
    status:
      lastState === 'merged'
        ? { code: 'ok', reasonCode: null }
        : { code: 'unset', reasonCode: 'stopped' },
    attributes,
    parentSpanId: null,
    events,
  });
}

/** Round spans: one per round with at least one built step span, withheld and closed as in plan §3.1. */
function buildRoundSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  roundOf: Map<number, RoundSpanInfo>,
  pendingStepRounds: ReadonlySet<number>,
  terminal: boolean,
  roundsStarted: ReadonlySet<number>,
  maxRoundStarted: number,
): void {
  for (let round = 0; round <= LANE_RUN_MAX_ROUND; round += 1) {
    const info = roundOf.get(round);
    if (info === undefined) {
      continue;
    }
    if (pendingStepRounds.has(round)) {
      continue;
    }
    if (!terminal && !(roundsStarted.size > 0 && maxRoundStarted > round)) {
      continue;
    }
    const identity = roundIdentity(round);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    builder.build({
      identity,
      name: 'round',
      kind: 'CHAIN',
      startIso: info.startIso,
      endIso: info.endIso,
      status: info.errored ?? { code: 'ok', reasonCode: null },
      attributes: { ...ctx.sharedAttributes },
      parentSpanId: ctx.rootSpanId,
      events: [],
    });
  }
}

/** The usage LLM child of an attempt span: only when a read usage was measured. */
function buildUsageSpan(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  attempt: AttemptRecord,
  attemptBuilt: TelemetrySpan,
  startIso: string,
  endIso: string,
): void {
  const usage = attempt.usage;
  if (usage?.source !== 'opencode-db' && usage?.source !== 'opencode-api') {
    return;
  }
  const usageInput = telemetryHashInput(attempt.id);
  const usageIdentityOf = usageInput === null ? null : usageIdentity(usageInput);
  if (usageIdentityOf === null) {
    ctx.rejected.count += 1;
    return;
  }
  builder.build({
    identity: usageIdentityOf,
    name: 'usage',
    kind: 'LLM',
    startIso,
    endIso,
    status: { code: 'unset', reasonCode: null },
    attributes: usageAttributes(attempt, usage),
    parentSpanId: attemptBuilt.spanId,
    events: [],
  });
}

/** Attempt and usage spans: an attempt's AGENT span under its round, its usage LLM child (plan §3.1). */
function buildAttemptSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  attempts: readonly AttemptRecord[],
  groups: readonly KeyGroup[],
  workOrderDigest: string,
): void {
  for (const attempt of attempts) {
    if (!(TERMINAL_ATTEMPT_STATES as readonly string[]).includes(attempt.state)) {
      continue;
    }
    const attemptInput = telemetryHashInput(attempt.id);
    if (attemptInput === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const identity = attemptIdentity(attemptInput);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const dispatch = findDispatchGroup(groups, attempt.id);
    if (dispatch === null) {
      continue;
    }
    const dispatchFinal = finalResultOf(dispatch.group.results);
    if (dispatchFinal === null) {
      continue;
    }
    const collect = findCollectGroup(groups, dispatch.round, dispatch.seatIndex);
    if (collect === null) {
      continue;
    }
    const collectFinal = finalResultOf(collect.results);
    if (collectFinal === null) {
      continue;
    }
    const roundIdentityOf = roundIdentity(dispatch.round);
    if (roundIdentityOf === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const roundSpanId = telemetrySpanId(ctx.hmac, ctx.root, roundIdentityOf);
    if (roundSpanId === null) {
      ctx.rejected.count += 1;
      continue;
    }
    if (!builder.spans.some((span) => span.spanId === roundSpanId)) {
      continue;
    }
    const attemptBuilt = builder.build({
      identity,
      name: 'attempt',
      kind: 'AGENT',
      startIso: dispatchFinal.recordedAtIso,
      endIso: collectFinal.recordedAtIso,
      status: { code: 'unset', reasonCode: null },
      attributes: attemptAttributes(ctx.hmac, attempt, workOrderDigest),
      parentSpanId: roundSpanId,
      events: [],
    });
    if (attemptBuilt === null) {
      continue;
    }
    buildUsageSpan(ctx, builder, attempt, attemptBuilt, dispatchFinal.recordedAtIso, collectFinal.recordedAtIso);
  }
}

/** Stop-request spans: the stop INTENT only, built after the attempt spans (plan §3.1). */
function buildStopRequestSpans(ctx: RunMapperContext, builder: SpanBuilder, groups: readonly KeyGroup[]): void {
  const pending: PendingSpan[] = [];
  for (const group of groups) {
    const parsed = parseLaneRunKey(group.key);
    if (parsed?.kind !== 'stop' || group.intent === null) {
      continue;
    }
    const hashInput = telemetryHashInput(group.key);
    if (hashInput === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const identity = journalKeyIdentity(hashInput);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const mode = stopModeOfKey(group.key);
    const attributes: Record<string, unknown> = { ...ctx.sharedAttributes };
    if (mode !== null) {
      attributes['fleet.stop.mode'] = mode;
    }
    pending.push({
      identity,
      name: 'stop-request',
      kind: 'DECISION',
      startIso: group.intent.recordedAtIso,
      endIso: group.intent.recordedAtIso,
      status: { code: 'unset', reasonCode: null },
      attributes,
      parentSpanId: ctx.rootSpanId,
      events: [],
    });
  }
  for (const span of pending) {
    builder.build(span);
  }
}

/** CI wait spans: a watching-ci conduct entry opens a span ending at the next conduct entry (plan §3.1). */
function buildCiWaitSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  conduct: readonly LaneRunJournalEntryRecord[],
): void {
  for (let index = 0; index < conduct.length; index += 1) {
    const entry = conduct[index];
    if (entry.state !== 'watching-ci') {
      continue;
    }
    const next = conduct[index + 1];
    if (next === undefined) {
      continue;
    }
    const identity = ciWaitIdentity(entry.entryId);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    builder.build({
      identity,
      name: 'ci-wait',
      kind: 'CHAIN',
      startIso: entry.recordedAtIso,
      endIso: next.recordedAtIso,
      status: { code: 'unset', reasonCode: null },
      attributes: { ...ctx.sharedAttributes },
      parentSpanId: ctx.rootSpanId,
      events: [],
    });
  }
}

/** Gate receipt spans of a hand-run trace (plan §3.1, §3.4). */
function buildGateReceiptSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  verification: readonly TelemetryGateReceiptFact[],
  attemptBuilt: TelemetrySpan,
): void {
  for (const receipt of verification) {
    const identity = verificationReceiptIdentity(receipt.receiptId);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    const attributes: Record<string, unknown> = { 'fleet.gate.result': receipt.result };
    if (receipt.exitCode !== null) {
      attributes['fleet.gate.exit_code'] = receipt.exitCode;
    }
    builder.build({
      identity,
      name: 'gate',
      kind: 'GUARDRAIL',
      startIso: receipt.completedAtIso,
      endIso: receipt.completedAtIso,
      status: { code: 'unset', reasonCode: null },
      attributes,
      parentSpanId: attemptBuilt.spanId,
      events: [],
    });
  }
}

/** Review receipt spans of a hand-run trace (plan §3.1, §3.4). */
function buildReviewReceiptSpans(
  ctx: RunMapperContext,
  builder: SpanBuilder,
  review: readonly TelemetryReviewReceiptFact[],
  attemptBuilt: TelemetrySpan,
): void {
  for (const receipt of review) {
    const identity = reviewReceiptIdentity(receipt.receiptId);
    if (identity === null) {
      ctx.rejected.count += 1;
      continue;
    }
    builder.build({
      identity,
      name: 'review',
      kind: 'EVALUATOR',
      startIso: receipt.completedAtIso,
      endIso: receipt.completedAtIso,
      status: { code: 'unset', reasonCode: null },
      attributes: {
        'fleet.review.kind': receipt.kind,
        'fleet.review.result': receipt.result,
        'fleet.review.findings.blocker': receipt.findings.blocker,
        'fleet.review.findings.major': receipt.findings.major,
        'fleet.review.findings.minor': receipt.findings.minor,
        'fleet.review.findings.nit': receipt.findings.nit,
      },
      parentSpanId: attemptBuilt.spanId,
      events: [],
    });
  }
}

/**
 * Map a conducted run to its closed telemetry spans (plan §3.1). Never throws;
 * a span whose identity, ids or build fails is counted in `rejectedInvalid`.
 */
export function laneRunSpans(hmac: TelemetryHmac, facts: LaneRunTelemetryFacts): LaneRunSpansResult {
  try {
    const root: TelemetryTraceRoot | null = runTraceRoot(facts.run.runId);
    if (root === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const traceId = telemetryTraceId(hmac, root);
    if (traceId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const rootSpanId = telemetrySpanId(hmac, root, runRootIdentity());
    if (rootSpanId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderInput = telemetryHashInput(facts.run.workOrderId);
    if (workOrderInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderDigest = telemetryDigest(hmac, 'work-order', workOrderInput);
    if (workOrderDigest === null) {
      return { spans: [], rejectedInvalid: 1 };
    }

    // session.id and fleet.work_order.digest go on every span of the run's
    // work order (plan §3.1, §3.2): both are the work order's salted digest.
    const builder = createSpanBuilder(hmac, root, traceId, 'lane-run');
    const ctx: RunMapperContext = {
      hmac,
      root,
      traceId,
      rootSpanId,
      sharedAttributes: {
        'session.id': workOrderDigest,
        'fleet.work_order.digest': workOrderDigest,
      },
      rejected: builder.rejected,
    };

    const journal = scopeJournal(facts);
    const groups = groupStepEntries(journal);
    const conduct = conductEntries(journal);
    const lastConduct = conduct.at(-1) ?? null;
    const terminal = isTerminal(lastConduct);
    const { roundsStarted, maxRoundStarted } = roundStartInfo(journal);

    const steps = buildStepSpans(ctx, builder, groups);
    buildRootSpan(ctx, builder, facts, journal, conduct, lastConduct, terminal);
    buildRoundSpans(ctx, builder, steps.roundOf, steps.pendingStepRounds, terminal, roundsStarted, maxRoundStarted);
    buildAttemptSpans(ctx, builder, facts.attempts, groups, workOrderDigest);
    buildStopRequestSpans(ctx, builder, groups);
    buildCiWaitSpans(ctx, builder, conduct);

    return { spans: builder.spans, rejectedInvalid: builder.rejected.count };
  } catch {
    return { spans: [], rejectedInvalid: 1 };
  }
}

/**
 * Map a hand-run attempt to its trace (plan §3.1, §3.4): the `attempt` AGENT
 * span is the root, its usage LLM child, and its gate and review receipt spans
 * as children, each identified by its receipt id and instant at the receipt's
 * `completedAtIso`. Emitted only once the attempt is terminal; an attempt that
 * belongs to a run (`conductedAttemptIds`) is never a hand-run trace. Never
 * throws; a span whose identity, ids or build fails is counted in
 * `rejectedInvalid`.
 */
export function attemptTraceSpans(hmac: TelemetryHmac, facts: AttemptTraceTelemetryFacts): LaneRunSpansResult {
  try {
    if (facts.conductedAttemptIds.has(facts.attempt.id)) {
      return { spans: [], rejectedInvalid: 0 };
    }
    if (!(TERMINAL_ATTEMPT_STATES as readonly string[]).includes(facts.attempt.state)) {
      return { spans: [], rejectedInvalid: 0 };
    }
    const attemptInput = telemetryHashInput(facts.attempt.id);
    if (attemptInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const root = attemptTraceRoot(attemptInput);
    if (root === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const traceId = telemetryTraceId(hmac, root);
    if (traceId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const identity = attemptIdentity(attemptInput);
    if (identity === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const attemptSpanId = telemetrySpanId(hmac, root, identity);
    if (attemptSpanId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderInput = telemetryHashInput(facts.attempt.workOrderId);
    if (workOrderInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderDigest = telemetryDigest(hmac, 'work-order', workOrderInput);
    if (workOrderDigest === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const startIso = facts.attempt.createdAtIso;
    const endIso =
      facts.attempt.completionReceipt !== null
        ? facts.attempt.completionReceipt.endedAtIso
        : facts.attempt.updatedAtIso;

    const builder = createSpanBuilder(hmac, root, traceId, 'attempt');
    const ctx: RunMapperContext = {
      hmac,
      root,
      traceId,
      rootSpanId: attemptSpanId,
      sharedAttributes: {},
      rejected: builder.rejected,
    };

    const attemptBuilt = builder.build({
      identity,
      name: 'attempt',
      kind: 'AGENT',
      startIso,
      endIso,
      status: { code: 'unset', reasonCode: null },
      attributes: attemptAttributes(hmac, facts.attempt, workOrderDigest),
      parentSpanId: null,
      events: [],
    });
    if (attemptBuilt === null) {
      return { spans: builder.spans, rejectedInvalid: builder.rejected.count };
    }

    buildUsageSpan(ctx, builder, facts.attempt, attemptBuilt, startIso, endIso);
    buildGateReceiptSpans(ctx, builder, facts.receipts.verification, attemptBuilt);
    buildReviewReceiptSpans(ctx, builder, facts.receipts.review, attemptBuilt);

    return { spans: builder.spans, rejectedInvalid: builder.rejected.count };
  } catch {
    return { spans: [], rejectedInvalid: 1 };
  }
}
